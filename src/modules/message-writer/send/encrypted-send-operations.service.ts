import {
  ConflictException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { prepareEncryptedMessage } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import type { PreparedEncryptedMessage } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { EncryptedSendCandidatesService } from './encrypted-send-candidates.service';

export type SendOperationState = 'REGISTERED' | 'COMMITTED';

export interface RegisteredSendOperation {
  readonly senderId: string;
  readonly messageId: string;
  readonly state: SendOperationState;
  readonly prepared: PreparedEncryptedMessage;
  readonly memberIds: readonly string[];
  readonly replayed: boolean;
}

const TABLE = 'e2e_send_operations';
const GENESIS_HASH = '0'.repeat(64);

const SERIAL_READ = {
  prepare: true,
  consistency: types.consistencies.localSerial,
};

const CAS_WRITE = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  serialConsistency: types.consistencies.localSerial,
};

@Injectable()
export class EncryptedSendOperationsService implements OnModuleInit {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly candidates: EncryptedSendCandidatesService,
  ) {}

  async onModuleInit(): Promise<void> {
    const result = await this.cassandra.client.execute(
      `SELECT default_time_to_live
       FROM system_schema.tables
       WHERE keyspace_name = ? AND table_name = ?`,
      [this.cassandra.client.keyspace, TABLE],
      { prepare: true },
    );

    if (result.first()?.get('default_time_to_live') !== 0) {
      throw new Error('NON_EXPIRING_TABLE_REQUIRED:e2e_send_operations');
    }
  }

  async register(
    senderId: string,
    body: unknown,
  ): Promise<RegisteredSendOperation> {
    const prepared = prepareEncryptedMessage(senderId, body);
    const existing = await this.read(prepared);
    if (!existing) {
      throw new ServiceUnavailableException('SEND_OPERATION_NOT_REGISTERED');
    }

    return this.restore(existing, senderId, prepared);
  }

  async recoverAccepted(
    chatId: string,
    entryKey: string,
  ): Promise<RegisteredSendOperation | null> {
    const accepted = await this.candidates.readAcceptedCandidate(
      chatId,
      entryKey,
    );
    if (!accepted) return null;

    const { candidate } = accepted;
    const { senderId, prepared, messageId } = candidate;
    const { message } = prepared;
    const existing = await this.read(prepared);
    if (existing) {
      const operation = this.restore(existing, senderId, prepared);
      if (operation.messageId !== messageId) {
        throw new ConflictException('ACCEPTED_MESSAGE_ID_MISMATCH');
      }

      return operation;
    }

    await this.assertPreviousCommitted(senderId, prepared);
    const participantIds = [
      ...new Set([
        senderId,
        ...message.envelope.recipients.map((recipient) => recipient.userId),
      ]),
    ].sort();

    if (participantIds.length > 64) {
      throw new ServiceUnavailableException(
        'INVALID_ACCEPTED_SEND_PARTICIPANTS',
      );
    }

    let applied = false;
    try {
      const result = await this.cassandra.client.execute(
        `
        INSERT INTO e2e_send_operations (
          chat_id,
          sender_device_id,
          seq,
          sender_id,
          message_id,
          message_hash,
          signature,
          request_json,
          member_ids,
          state,
          delivery_state
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        IF NOT EXISTS
      `,
        [
          message.chatId,
          message.senderDeviceId,
          types.Long.fromNumber(message.seq),
          senderId,
          types.TimeUuid.fromString(messageId),
          prepared.messageHash,
          message.signature,
          JSON.stringify(message),
          participantIds.map((id) => types.Uuid.fromString(id)),
          'REGISTERED',
          'PENDING',
        ],
        { ...CAS_WRITE, isIdempotent: false },
      );

      applied = result.wasApplied();
    } catch {}

    let stored: types.Row | null;
    try {
      stored = await this.read(prepared);
    } catch {
      throw new ServiceUnavailableException(
        'ACCEPTED_SEND_REGISTRATION_UNKNOWN',
      );
    }

    if (!stored) {
      throw new ServiceUnavailableException(
        'ACCEPTED_SEND_REGISTRATION_UNKNOWN',
      );
    }

    const operation = this.restore(stored, senderId, prepared);
    if (operation.messageId !== messageId) {
      throw new ConflictException('ACCEPTED_MESSAGE_ID_MISMATCH');
    }

    return Object.freeze({
      ...operation,
      replayed: !applied,
    });
  }

  async assertReadyForAdmission(
    senderId: string,
    prepared: PreparedEncryptedMessage,
  ): Promise<void> {
    const existing = await this.read(prepared);
    if (existing) {
      this.restore(existing, senderId, prepared);

      throw new ServiceUnavailableException(
        'SEND_OPERATION_EXISTS_RETRY_SAME_REQUEST',
      );
    }

    await this.assertPreviousCommitted(senderId, prepared);
  }

  private async assertPreviousCommitted(
    senderId: string,
    prepared: PreparedEncryptedMessage,
  ): Promise<void> {
    const { message } = prepared;
    if (message.seq === 1) {
      if (message.prevHash !== GENESIS_HASH) {
        throw new ConflictException('DEVICE_CHAIN_MISMATCH');
      }
      return;
    }

    const result = await this.cassandra.client.execute(
      `SELECT sender_id, message_hash, state
       FROM e2e_send_operations
       WHERE chat_id = ?
         AND sender_device_id = ?
         AND seq = ?`,
      [
        message.chatId,
        message.senderDeviceId,
        types.Long.fromNumber(message.seq - 1),
      ],
      SERIAL_READ,
    );

    const previous = result.first();
    if (
      !previous ||
      String(previous.get('sender_id')) !== senderId ||
      previous.get('message_hash') !== message.prevHash
    ) {
      throw new ConflictException('DEVICE_CHAIN_MISMATCH');
    }

    const state: unknown = previous.get('state');
    if (state === 'REGISTERED') {
      throw new ConflictException('PREVIOUS_SEND_NOT_COMMITTED');
    }
    if (state !== 'COMMITTED') {
      throw new ServiceUnavailableException('INVALID_SEND_OPERATION_STATE');
    }
  }

  private async read(
    prepared: PreparedEncryptedMessage,
  ): Promise<types.Row | null> {
    const { message } = prepared;
    const result = await this.cassandra.client.execute(
      `SELECT
         sender_id,
         message_id,
         message_hash,
         signature,
         member_ids,
         state
       FROM e2e_send_operations
       WHERE chat_id = ?
         AND sender_device_id = ?
         AND seq = ?`,
      [
        message.chatId,
        message.senderDeviceId,
        types.Long.fromNumber(message.seq),
      ],
      SERIAL_READ,
    );

    return result.first() ?? null;
  }

  private restore(
    row: types.Row,
    senderId: string,
    prepared: PreparedEncryptedMessage,
  ): RegisteredSendOperation {
    if (
      String(row.get('sender_id')) !== senderId ||
      row.get('message_hash') !== prepared.messageHash ||
      row.get('signature') !== prepared.message.signature
    ) {
      throw new ConflictException('SEND_OPERATION_REUSED');
    }

    const state: unknown = row.get('state');
    if (state !== 'REGISTERED' && state !== 'COMMITTED') {
      throw new ServiceUnavailableException('INVALID_SEND_OPERATION_STATE');
    }

    const storedMessageId: unknown = row.get('message_id');
    const storedMembers: unknown = row.get('member_ids');
    if (
      !(storedMessageId instanceof types.TimeUuid) ||
      !Array.isArray(storedMembers) ||
      storedMembers.length === 0 ||
      storedMembers.length > 64
    ) {
      throw new ServiceUnavailableException('INVALID_SEND_OPERATION_RECORD');
    }

    const memberIds: string[] = [];
    for (const member of storedMembers as unknown[]) {
      if (!(member instanceof types.Uuid)) {
        throw new ServiceUnavailableException('INVALID_SEND_OPERATION_RECORD');
      }

      memberIds.push(member.toString());
    }

    return Object.freeze({
      senderId,
      messageId: storedMessageId.toString(),
      state,
      prepared,
      memberIds: Object.freeze(memberIds),
      replayed: true,
    });
  }
}
