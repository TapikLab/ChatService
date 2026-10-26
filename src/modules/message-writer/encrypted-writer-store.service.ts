import {
  ConflictException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatChainService } from '@modules/messages/signing/chat-chain.service';
import type { EncryptedEnvelope } from '@modules/messages/e2e/encrypted-message.contract';
import { EncryptedSendOperationsService } from './encrypted-send-operations.service';
import type { RegisteredSendOperation } from './encrypted-send-operations.service';
import { EncryptedDeliveryOutboxService } from './encrypted-delivery-outbox.service';

export interface StoredEncryptedMessage {
  readonly chatId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderDeviceId: string;
  readonly type: 'e2e_v1';
  readonly envelope: EncryptedEnvelope;
  readonly seq: number;
  readonly prevHash: string;
  readonly signature: string;
  readonly chatSeq: number;
  readonly chainHash: string;
  readonly messageHash: string;
  readonly createdAt: string;
  readonly replayed: boolean;
}

const SERIAL_READ = {
  prepare: true,
  consistency: types.consistencies.localSerial,
};

const CAS_WRITE = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  serialConsistency: types.consistencies.localSerial,
};

const HASH = /^[0-9a-f]{64}$/;

@Injectable()
export class EncryptedWriterStoreService implements OnModuleInit {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly operations: EncryptedSendOperationsService,
    private readonly chain: ChatChainService,
    private readonly outbox: EncryptedDeliveryOutboxService,
  ) {}

  async onModuleInit(): Promise<void> {
    const result = await this.cassandra.client.execute(
      `SELECT type
       FROM system_schema.columns
       WHERE keyspace_name = ?
         AND table_name = ?
         AND column_name = ?`,
      [this.cassandra.client.keyspace, 'messages', 'envelope'],
      { prepare: true },
    );

    const columnType: unknown = result.first()?.get('type');
    if (columnType !== 'text' && columnType !== 'varchar') {
      throw new Error('MESSAGES_ENVELOPE_COLUMN_REQUIRED');
    }
  }

  async append(
    senderId: string,
    body: unknown,
  ): Promise<StoredEncryptedMessage> {
    const operation = await this.operations.register(senderId, body);
    await this.outbox.ensurePending(operation);
    let stored = await this.read(operation);
    if (!stored) {
      if (operation.state === 'COMMITTED') {
        throw new ServiceUnavailableException('COMMITTED_MESSAGE_MISSING');
      }

      const { message } = operation.prepared;
      const messageId = types.TimeUuid.fromString(operation.messageId);
      const position = await this.chain.append({
        chatId: message.chatId,
        messageId,
        messageHash: operation.prepared.messageHash,
        kind: 'signed',
      });

      await this.cassandra.client.execute(
        `INSERT INTO messages (
           chat_id,
           message_id,
           sender_id,
           sender_device_id,
           content,
           attachments,
           envelope,
           type,
           created_at,
           via_assistant,
           seq,
           prev_hash,
           signature,
           chat_seq,
           chain_hash,
           message_hash,
           edit_of
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         IF NOT EXISTS`,
        [
          message.chatId,
          messageId,
          operation.senderId,
          message.senderDeviceId,
          null,
          [],
          operation.prepared.serializedEnvelope,
          'e2e_v1',
          messageId.getDate(),
          false,
          types.Long.fromNumber(message.seq),
          message.prevHash,
          message.signature,
          types.Long.fromNumber(position.chatSeq),
          position.chainHash,
          operation.prepared.messageHash,
          null,
        ],
        CAS_WRITE,
      );

      stored = await this.read(operation);
      if (!stored) {
        throw new ServiceUnavailableException('MESSAGE_COMMIT_NOT_VISIBLE');
      }
      if (
        stored.chatSeq !== position.chatSeq ||
        stored.chainHash !== position.chainHash
      ) {
        throw new ConflictException('MESSAGE_CHAIN_POSITION_MISMATCH');
      }
    }
    if (operation.state !== 'COMMITTED') {
      await this.markCommitted(operation);
    }

    return stored;
  }

  private async read(
    operation: RegisteredSendOperation,
  ): Promise<StoredEncryptedMessage | null> {
    const { prepared } = operation;
    const { message } = prepared;
    const result = await this.cassandra.client.execute(
      `SELECT
         sender_id,
         sender_device_id,
         content,
         attachments,
         envelope,
         type,
         created_at,
         via_assistant,
         seq,
         prev_hash,
         signature,
         chat_seq,
         chain_hash,
         message_hash,
         edit_of
       FROM messages
       WHERE chat_id = ? AND message_id = ?`,
      [message.chatId, types.TimeUuid.fromString(operation.messageId)],
      SERIAL_READ,
    );

    const row = result.first();
    if (!row) return null;

    const storedSeq: unknown = row.get('seq');
    const storedChatSeq: unknown = row.get('chat_seq');
    const storedChainHash: unknown = row.get('chain_hash');
    const createdAt: unknown = row.get('created_at');
    const attachments: unknown = row.get('attachments');
    if (
      !(storedSeq instanceof types.Long) ||
      !(storedChatSeq instanceof types.Long) ||
      !(createdAt instanceof Date) ||
      typeof storedChainHash !== 'string' ||
      !HASH.test(storedChainHash)
    ) {
      throw new ServiceUnavailableException('INVALID_ENCRYPTED_MESSAGE_RECORD');
    }

    const chatSeq = storedChatSeq.toNumber();
    if (!Number.isSafeInteger(chatSeq) || chatSeq < 1) {
      throw new ServiceUnavailableException('INVALID_CHAT_SEQUENCE');
    }

    const expectedCreatedAt = types.TimeUuid.fromString(
      operation.messageId,
    ).getDate();
    const hasNoAttachments =
      attachments == null ||
      (Array.isArray(attachments) && attachments.length === 0);

    if (
      String(row.get('sender_id')) !== operation.senderId ||
      String(row.get('sender_device_id')) !== message.senderDeviceId ||
      row.get('type') !== 'e2e_v1' ||
      row.get('envelope') !== prepared.serializedEnvelope ||
      row.get('message_hash') !== prepared.messageHash ||
      row.get('signature') !== message.signature ||
      row.get('prev_hash') !== message.prevHash ||
      !storedSeq.equals(types.Long.fromNumber(message.seq)) ||
      createdAt.getTime() !== expectedCreatedAt.getTime() ||
      row.get('via_assistant') !== false ||
      row.get('content') != null ||
      row.get('edit_of') != null ||
      !hasNoAttachments
    ) {
      throw new ConflictException('MESSAGE_ID_REUSED');
    }

    return Object.freeze({
      chatId: message.chatId,
      messageId: operation.messageId,
      senderId: operation.senderId,
      senderDeviceId: message.senderDeviceId,
      type: 'e2e_v1' as const,
      envelope: message.envelope,
      seq: message.seq,
      prevHash: message.prevHash,
      signature: message.signature,
      chatSeq,
      chainHash: storedChainHash,
      messageHash: prepared.messageHash,
      createdAt: createdAt.toISOString(),
      replayed: operation.replayed,
    });
  }

  private async markCommitted(
    operation: RegisteredSendOperation,
  ): Promise<void> {
    const { prepared } = operation;
    const { message } = prepared;
    const messageId = types.TimeUuid.fromString(operation.messageId);
    const result = await this.cassandra.client.execute(
      `UPDATE e2e_send_operations
       SET state = ?
       WHERE chat_id = ?
         AND sender_device_id = ?
         AND seq = ?
       IF state = ?
         AND sender_id = ?
         AND message_id = ?
         AND message_hash = ?
         AND signature = ?`,
      [
        'COMMITTED',
        message.chatId,
        message.senderDeviceId,
        types.Long.fromNumber(message.seq),
        'REGISTERED',
        operation.senderId,
        messageId,
        prepared.messageHash,
        message.signature,
      ],
      CAS_WRITE,
    );

    if (result.wasApplied()) return;
    const current = await this.cassandra.client.execute(
      `SELECT
         state,
         sender_id,
         message_id,
         message_hash,
         signature
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

    const row = current.first();

    if (
      !row ||
      row.get('state') !== 'COMMITTED' ||
      String(row.get('sender_id')) !== operation.senderId ||
      String(row.get('message_id')) !== operation.messageId ||
      row.get('message_hash') !== prepared.messageHash ||
      row.get('signature') !== message.signature
    ) {
      throw new ServiceUnavailableException(
        'SEND_OPERATION_COMMIT_NOT_CONFIRMED',
      );
    }
  }
}
