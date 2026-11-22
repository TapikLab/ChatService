import {
  BadRequestException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import {
  admissionLong,
  admissionNumber,
  admissionUuid,
} from '@modules/message-writer/admission/chat-admission.validation';
import {
  DELIVERY_SHARD_COUNT,
  deliveryShard,
} from '@modules/message-writer/outbox/encrypted-delivery-outbox.service';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';

export interface SendRecoveryTask {
  readonly shard: number;
  readonly chatId: string;
  readonly senderDeviceId: string;
  readonly seq: number;
  readonly expectedRevision: number;
  readonly createdAtMs: number;
}

const PAGE_SIZE = 16;
const STALE_ATTEMPT_MS = 5 * 60 * 1000;
const TABLE = 'e2e_send_recovery_pending_v2';

const READ_OPTIONS = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  isIdempotent: true,
};

const SERIAL_READ = {
  prepare: true,
  consistency: types.consistencies.localSerial,
};

const WRITE_OPTIONS = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  isIdempotent: true,
};

@Injectable()
export class EncryptedSendRecoveryService implements OnModuleInit {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly admission: ChatAdmissionRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const result = await this.cassandra.client.execute(
      `
        SELECT default_time_to_live
        FROM system_schema.tables
        WHERE keyspace_name = ?
          AND table_name = ?
      `,
      [this.cassandra.client.keyspace, TABLE],
      { prepare: true },
    );

    if (result.first()?.get('default_time_to_live') !== 0) {
      throw new Error(
        'NON_EXPIRING_TABLE_REQUIRED:e2e_send_recovery_pending_v2',
      );
    }
  }

  async ensurePending(
    chatId: string,
    senderDeviceId: string,
    seq: number,
    expectedRevision: number,
  ): Promise<void> {
    admissionUuid(chatId);
    admissionUuid(senderDeviceId);
    admissionNumber(seq, 1);
    admissionNumber(expectedRevision, 0);

    const shard = deliveryShard(chatId, senderDeviceId, seq);
    try {
      await this.cassandra.client.execute(
        `
          INSERT INTO e2e_send_recovery_pending_v2 (
            shard,
            chat_id,
            sender_device_id,
            seq,
            expected_revision,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          shard,
          chatId,
          senderDeviceId,
          types.Long.fromNumber(seq),
          types.Long.fromNumber(expectedRevision),
          new Date(),
        ],
        WRITE_OPTIONS,
      );
    } catch {
      throw new ServiceUnavailableException(
        'SEND_RECOVERY_REGISTRATION_UNKNOWN',
      );
    }
  }

  async readPending(
    shard: number,
    after?: SendRecoveryTask,
  ): Promise<readonly SendRecoveryTask[]> {
    admissionNumber(shard, 0);

    if (shard >= DELIVERY_SHARD_COUNT) {
      throw new BadRequestException('INVALID_RECOVERY_SHARD');
    }

    if (after !== undefined) {
      this.assertTask(after);
      if (after.shard !== shard) {
        throw new BadRequestException('INVALID_RECOVERY_CURSOR');
      }
    }

    const query = after
      ? `
          SELECT
            chat_id,
            sender_device_id,
            seq,
            expected_revision,
            created_at
          FROM e2e_send_recovery_pending_v2
          WHERE shard = ?
            AND (
              chat_id,
              sender_device_id,
              seq,
              expected_revision
            ) > (?, ?, ?, ?)
          LIMIT ?
        `
      : `
          SELECT
            chat_id,
            sender_device_id,
            seq,
            expected_revision,
            created_at
          FROM e2e_send_recovery_pending_v2
          WHERE shard = ?
          LIMIT ?
        `;

    const parameters: unknown[] = after
      ? [
          shard,
          after.chatId,
          after.senderDeviceId,
          types.Long.fromNumber(after.seq),
          types.Long.fromNumber(after.expectedRevision),
          PAGE_SIZE,
        ]
      : [shard, PAGE_SIZE];

    let rows: types.Row[];
    try {
      const result = await this.cassandra.client.execute(query, parameters, {
        ...READ_OPTIONS,
        fetchSize: PAGE_SIZE,
      });

      rows = result.rows;
    } catch {
      throw new ServiceUnavailableException('SEND_RECOVERY_READ_UNAVAILABLE');
    }

    try {
      const tasks = rows.map((row): SendRecoveryTask => {
        const createdAt: unknown = row.get('created_at');
        if (
          !(createdAt instanceof Date) ||
          !Number.isFinite(createdAt.getTime())
        ) {
          throw new Error('INVALID_RECOVERY_CREATED_AT');
        }

        const task: SendRecoveryTask = {
          shard,
          chatId: admissionUuid(String(row.get('chat_id'))),
          senderDeviceId: admissionUuid(String(row.get('sender_device_id'))),
          seq: admissionLong(row.get('seq'), 1),
          expectedRevision: admissionLong(row.get('expected_revision'), 0),
          createdAtMs: createdAt.getTime(),
        };

        this.assertTask(task);

        return Object.freeze(task);
      });

      return Object.freeze(tasks);
    } catch {
      throw new ServiceUnavailableException('INVALID_SEND_RECOVERY_RECORD');
    }
  }

  async discardIfStaleAndUnaccepted(task: SendRecoveryTask): Promise<boolean> {
    this.assertTask(task);

    if (Date.now() - task.createdAtMs < STALE_ATTEMPT_MS) return false;

    await this.admission.fenceRevision(task.chatId, task.expectedRevision);

    const receipt = await this.admission.readReceipt(
      task.chatId,
      `send:${task.senderDeviceId}:${task.seq}`,
    );
    if (receipt) return false;

    await this.removeTask(task);
    return true;
  }

  async removeIfPublished(
    task: SendRecoveryTask,
    messageId: string,
    messageHash: string,
  ): Promise<boolean> {
    this.assertTask(task);
    admissionUuid(messageId);

    if (
      typeof messageHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(messageHash)
    ) {
      throw new BadRequestException('INVALID_RECOVERY_MESSAGE_HASH');
    }

    let row: types.Row | null;
    try {
      const result = await this.cassandra.client.execute(
        `
        SELECT
          message_id,
          message_hash,
          state,
          delivery_state
        FROM e2e_send_operations
        WHERE chat_id = ?
          AND sender_device_id = ?
          AND seq = ?
      `,
        [task.chatId, task.senderDeviceId, types.Long.fromNumber(task.seq)],
        SERIAL_READ,
      );

      row = result.first() ?? null;
    } catch {
      throw new ServiceUnavailableException(
        'SEND_RECOVERY_COMPLETION_UNAVAILABLE',
      );
    }

    if (
      !row ||
      String(row.get('message_id')) !== messageId ||
      row.get('message_hash') !== messageHash
    ) {
      throw new ServiceUnavailableException('SEND_RECOVERY_OPERATION_MISMATCH');
    }

    const state: unknown = row.get('state');
    const deliveryState: unknown = row.get('delivery_state');

    if (
      (state !== 'REGISTERED' && state !== 'COMMITTED') ||
      (deliveryState !== 'PENDING' && deliveryState !== 'PUBLISHED') ||
      (deliveryState === 'PUBLISHED' && state !== 'COMMITTED')
    ) {
      throw new ServiceUnavailableException('INVALID_SEND_RECOVERY_STATE');
    }

    if (state !== 'COMMITTED' || deliveryState !== 'PUBLISHED') {
      return false;
    }

    await this.removeTask(task);

    return true;
  }

  private assertTask(task: SendRecoveryTask): void {
    admissionUuid(task.chatId);
    admissionUuid(task.senderDeviceId);
    admissionNumber(task.seq, 1);
    admissionNumber(task.expectedRevision, 0);
    admissionNumber(task.shard, 0);

    if (
      task.shard >= DELIVERY_SHARD_COUNT ||
      !Number.isSafeInteger(task.createdAtMs) ||
      deliveryShard(task.chatId, task.senderDeviceId, task.seq) !== task.shard
    ) {
      throw new BadRequestException('INVALID_RECOVERY_TASK');
    }
  }

  private async removeTask(task: SendRecoveryTask): Promise<void> {
    try {
      await this.cassandra.client.execute(
        `
          DELETE FROM e2e_send_recovery_pending_v2
          WHERE shard = ?
            AND chat_id = ?
            AND sender_device_id = ?
            AND seq = ?
            AND expected_revision = ?
        `,
        [
          task.shard,
          task.chatId,
          task.senderDeviceId,
          types.Long.fromNumber(task.seq),
          types.Long.fromNumber(task.expectedRevision),
        ],
        WRITE_OPTIONS,
      );
    } catch {
      throw new ServiceUnavailableException('SEND_RECOVERY_REMOVAL_UNKNOWN');
    }
  }
}
