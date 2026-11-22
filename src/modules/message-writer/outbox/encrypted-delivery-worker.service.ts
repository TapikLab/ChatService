import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { prepareEncryptedMessage } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { DELIVERY_SHARD_COUNT } from './encrypted-delivery-outbox.service';
import { EncryptedWriterStoreService } from '@modules/message-writer/send/encrypted-writer-store.service';
import { EncryptedEventPublisher } from './encrypted-event-publisher.service';

type Cursor = [types.Uuid, types.Uuid, types.Long];

interface DeliveryTask {
  shard: number;
  chatId: string;
  deviceId: string;
  seq: number;
  messageId: string;
  messageHash: string;
}

const PAGE_SIZE = 8;
const PARALLEL_SHARDS = 4;

const READ = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
};

const SERIAL_READ = {
  prepare: true,
  consistency: types.consistencies.localSerial,
};

const CAS_WRITE = {
  ...READ,
  serialConsistency: types.consistencies.localSerial,
};

@Injectable()
export class EncryptedDeliveryWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(EncryptedDeliveryWorker.name);
  private readonly cursors = new Map<number, Cursor>();
  private shards: number[] = [];
  private nextShard = 0;
  private stopping = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly cassandra: CassandraService,
    private readonly writer: EncryptedWriterStoreService,
    private readonly publisher: EncryptedEventPublisher,
  ) {}

  onApplicationBootstrap(): void {
    const enable = this.config.get<string>('OUTBOX_WORKER_ENABLED', 'false');
    if (enable !== 'true' && enable !== 'false') {
      throw new Error('INVALID_OUTBOX_WORKER_ENABLED');
    }
    if (enable === 'false') return;

    const count = this.integerSetting(
      'OUTBOX_WORKER_COUNT',
      1,
      1,
      DELIVERY_SHARD_COUNT,
    );
    const index = this.integerSetting('OUTBOX_WORKER_INDEX', 0, 0, count - 1);

    this.shards = Array.from(
      { length: DELIVERY_SHARD_COUNT },
      (_, shard) => shard,
    ).filter((shard) => shard % count === index);

    this.schedule(0);
  }

  private integerSetting(
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = this.config.get<string>(name);
    if (raw !== undefined && !/^(0|[1-9][0-9]*)$/.test(raw)) {
      throw new Error(`INVALID_${name}`);
    }
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`INVALID_${name}`);
    }

    return value;
  }

  private schedule(delay: number): void {
    if (this.stopping) return;

    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch(() => {
          this.logger.error('E2EE_OUTBOX_POLL_FAILED');
        })
        .then(() => {
          this.schedule(this.publisher.isReady() ? 50 : 1_000);
        });
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.stopping || !this.publisher.isReady()) return;

    const selected: number[] = [];
    for (let i = 0; i < Math.min(PARALLEL_SHARDS, this.shards.length); i++) {
      selected.push(this.shards[this.nextShard]!);
      this.nextShard = (this.nextShard + 1) % this.shards.length;
    }

    const results = await Promise.allSettled(
      selected.map((shard) => this.processPage(shard)),
    );

    if (results.some((result) => result.status === 'rejected'))
      this.logger.error('E2EE_OUTBOX_SHARD_FAILED');
  }

  private async processPage(shard: number): Promise<void> {
    const cursor = this.cursors.get(shard);
    const query = cursor
      ? `SELECT *
         FROM e2e_delivery_pending
         WHERE shard = ?
           AND (chat_id, sender_device_id, seq) > (?, ?, ?)
         LIMIT ?`
      : `SELECT *
         FROM e2e_delivery_pending
         WHERE shard = ?
         LIMIT ?`;

    const parameters: unknown[] = cursor
      ? [shard, ...cursor, PAGE_SIZE]
      : [shard, PAGE_SIZE];

    const result = await this.cassandra.client.execute(query, parameters, {
      ...READ,
      fetchSize: PAGE_SIZE,
    });

    if (result.rows.length === 0) {
      this.cursors.delete(shard);
      return;
    }

    let failures = 0;
    for (const row of result.rows) {
      if (this.stopping) break;
      try {
        const seq = row.get('seq') as types.Long;
        const sequence = seq.toNumber();
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
          throw new Error('INVALID_OUTBOX_SEQUENCE');
        }

        await this.processTask({
          shard,
          chatId: String(row.get('chat_id')),
          deviceId: String(row.get('sender_device_id')),
          seq: sequence,
          messageId: String(row.get('message_id')),
          messageHash: row.get('message_hash') as string,
        });
      } catch {
        failures++;
      }

      this.cursors.set(shard, [
        row.get('chat_id') as types.Uuid,
        row.get('sender_device_id') as types.Uuid,
        row.get('seq') as types.Long,
      ]);
    }

    if (failures > 0)
      this.logger.warn(
        `E2EE_OUTBOX_TASK_FAILURES shard=${shard} count=${failures}`,
      );
  }

  private async processTask(task: DeliveryTask): Promise<void> {
    const result = await this.cassandra.client.execute(
      `SELECT
         sender_id,
         message_id,
         message_hash,
         request_json,
         state,
         delivery_state
       FROM e2e_send_operations
       WHERE chat_id = ?
         AND sender_device_id = ?
         AND seq = ?`,
      this.operationKey(task),
      SERIAL_READ,
    );

    const operation = result.first();
    if (
      !operation ||
      String(operation.get('message_id')) !== task.messageId ||
      operation.get('message_hash') !== task.messageHash
    ) {
      throw new Error('OUTBOX_OPERATION_MISMATCH');
    }

    const state: unknown = operation.get('state');
    const deliveryState: unknown = operation.get('delivery_state');
    if (deliveryState === 'PUBLISHED') {
      if (state !== 'COMMITTED') {
        throw new Error('INVALID_DELIVERY_STATE');
      }

      await this.removeTask(task);
      return;
    }

    if (
      deliveryState !== 'PENDING' ||
      (state !== 'REGISTERED' && state !== 'COMMITTED')
    ) {
      throw new Error('INVALID_DELIVERY_STATE');
    }

    const raw: unknown = operation.get('request_json');
    if (typeof raw !== 'string' || raw.length > 256 * 1024) {
      throw new Error('INVALID_STORED_E2EE_REQUEST');
    }

    const senderId = String(operation.get('sender_id'));
    const body: unknown = JSON.parse(raw);
    const prepared = prepareEncryptedMessage(senderId, body);
    if (
      prepared.message.chatId !== task.chatId ||
      prepared.message.senderDeviceId !== task.deviceId ||
      prepared.message.seq !== task.seq ||
      prepared.messageHash !== task.messageHash
    ) {
      throw new Error('OUTBOX_REQUEST_MISMATCH');
    }

    const message = await this.writer.append(senderId, body);
    if (
      message.messageId !== task.messageId ||
      message.messageHash !== task.messageHash
    ) {
      throw new Error('OUTBOX_MESSAGE_MISMATCH');
    }

    await this.publisher.publish(message);
    await this.markPublished(task);
    await this.removeTask(task);
  }

  private operationKey(task: DeliveryTask): unknown[] {
    return [task.chatId, task.deviceId, types.Long.fromNumber(task.seq)];
  }

  private async markPublished(task: DeliveryTask): Promise<void> {
    try {
      const result = await this.cassandra.client.execute(
        `UPDATE e2e_send_operations
         SET delivery_state = 'PUBLISHED'
         WHERE chat_id = ?
           AND sender_device_id = ?
           AND seq = ?
         IF state = 'COMMITTED'
           AND delivery_state = 'PENDING'
           AND message_id = ?
           AND message_hash = ?`,
        [
          ...this.operationKey(task),
          types.TimeUuid.fromString(task.messageId),
          task.messageHash,
        ],
        CAS_WRITE,
      );

      if (result.wasApplied()) return;
    } catch {
      // A failed response does not prove that the conditional write failed.
      // Confirm the durable state before removing the outbox task.
    }

    const current = await this.cassandra.client.execute(
      `SELECT state, delivery_state, message_id, message_hash
       FROM e2e_send_operations
       WHERE chat_id = ?
         AND sender_device_id = ?
         AND seq = ?`,
      this.operationKey(task),
      SERIAL_READ,
    );

    const row = current.first();
    if (
      !row ||
      row.get('state') !== 'COMMITTED' ||
      row.get('delivery_state') !== 'PUBLISHED' ||
      String(row.get('message_id')) !== task.messageId ||
      row.get('message_hash') !== task.messageHash
    ) {
      throw new Error('PUBLICATION_NOT_RECORDED');
    }
  }

  private async removeTask(task: DeliveryTask): Promise<void> {
    await this.cassandra.client.execute(
      `DELETE FROM e2e_delivery_pending
       WHERE shard = ?
         AND chat_id = ?
         AND sender_device_id = ?
         AND seq = ?`,
      [task.shard, ...this.operationKey(task)],
      { ...READ, isIdempotent: true },
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
    }

    await this.running;
  }
}
