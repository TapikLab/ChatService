import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatAccessService } from '@modules/chat-access/chat-access.service';
import { decodeStoredGroupEnvelope } from '@modules/messages/e2e/protocol/group-envelope.contract';
import {
  E2EE_LIMIT,
  prepareEncryptedMessage,
} from '@modules/messages/e2e/protocol/encrypted-message.contract';
import type { SendEncryptedMessage } from '@modules/messages/e2e/protocol/encrypted-message.contract';

export type EncryptedMessageResponse = SendEncryptedMessage & {
  readonly messageId: string;
  readonly senderId: string;
  readonly type: 'e2e_v1';
  readonly chatSeq: number;
  readonly chainHash: string;
  readonly messageHash: string;
  readonly createdAt: string;
};

export interface EncryptedSyncEntry {
  readonly chatSeq: number;
  readonly chainHash: string;
  readonly messageHash: string;
  readonly message: EncryptedMessageResponse | null;
}

export interface EncryptedSyncPage {
  readonly entries: readonly EncryptedSyncEntry[];
  readonly nextAfter: number;
  readonly hasMore: boolean;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIME_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

const MAX_ENVELOPE_CHARACTERS = 256 * 1024;

const QUORUM_READ = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
};

function invalidRecord(): never {
  throw new ServiceUnavailableException('INVALID_ENCRYPTED_MESSAGE_RECORD');
}

function positiveSequence(value: unknown): number {
  if (!(value instanceof types.Long)) return invalidRecord();

  const number = value.toNumber();
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !value.equals(types.Long.fromNumber(number))
  )
    return invalidRecord();

  return number;
}

function decodeEnvelope(value: unknown): unknown {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ENVELOPE_CHARACTERS
  )
    return invalidRecord();

  const parsed: unknown = JSON.parse(value);
  if (Array.isArray(parsed) && parsed[0] === 'e2e_group_v1')
    return decodeStoredGroupEnvelope(parsed);

  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== 'e2e_v1')
    return invalidRecord();

  const packets: unknown = parsed[1];
  if (
    !Array.isArray(packets) ||
    packets.length === 0 ||
    packets.length > E2EE_LIMIT.maxRecipients
  )
    return invalidRecord();

  return {
    mode: 'e2e_v1',
    recipients: packets.map((packet: unknown) => {
      if (!Array.isArray(packet) || packet.length !== 4) return invalidRecord();

      return {
        userId: packet[0] as unknown,
        deviceId: packet[1] as unknown,
        messageType: packet[2] as unknown,
        payload: packet[3] as unknown,
      };
    }),
  };
}

function pageNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;

  if (
    typeof value !== 'string' ||
    value.length > 16 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new BadRequestException('INVALID_SYNC_QUERY');
  }

  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new BadRequestException('INVALID_SYNC_QUERY');
  }

  return number;
}

@Injectable()
export class EncryptedMessageReaderService {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly access: ChatAccessService,
  ) {}

  async getOne(
    userId: string,
    chatId: string,
    messageId: string,
  ): Promise<EncryptedMessageResponse> {
    if (typeof userId !== 'string' || !UUID.test(userId)) {
      throw new UnauthorizedException();
    }

    if (
      typeof chatId !== 'string' ||
      !UUID.test(chatId) ||
      typeof messageId !== 'string' ||
      !TIME_UUID.test(messageId)
    ) {
      throw new BadRequestException('INVALID_MESSAGE_ADDRESS');
    }

    if (!(await this.access.isMember(chatId, userId))) {
      throw new NotFoundException('MESSAGE_NOT_FOUND');
    }

    const result = await this.cassandra.client.execute(
      `
        SELECT
          sender_id,
          sender_device_id,
          type,
          envelope,
          seq,
          prev_hash,
          signature,
          chat_seq,
          chain_hash,
          message_hash,
          created_at
        FROM messages
        WHERE chat_id = ? AND message_id = ?
      `,
      [chatId, types.TimeUuid.fromString(messageId)],
      QUORUM_READ,
    );

    const row = result.first();
    if (!row) {
      throw new NotFoundException('MESSAGE_NOT_FOUND');
    }

    const message = this.restore(row, chatId, messageId);
    const addressedToUser =
      message.senderId === userId ||
      message.envelope.recipients.some(
        (recipient) => recipient.userId === userId,
      );

    if (!addressedToUser) {
      throw new NotFoundException('MESSAGE_NOT_FOUND');
    }

    await this.assertCommitted(message);

    return message;
  }

  async getPage(
    userId: string,
    chatId: string,
    afterInput: unknown,
    limitInput: unknown,
  ): Promise<EncryptedSyncPage> {
    if (typeof userId !== 'string' || !UUID.test(userId)) {
      throw new UnauthorizedException();
    }
    if (typeof chatId !== 'string' || !UUID.test(chatId)) {
      throw new BadRequestException('INVALID_CHAT_ID');
    }

    const after = pageNumber(afterInput, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = pageNumber(limitInput, 10, 1, 10);

    if (!(await this.access.isMember(chatId, userId))) {
      throw new NotFoundException('CHAT_NOT_FOUND');
    }

    const chainResult = await this.cassandra.client.execute(
      `
      SELECT chat_seq, message_id, message_hash, chain_hash
      FROM chat_chain_log
      WHERE chat_id = ? AND chat_seq > ?
      ORDER BY chat_seq ASC
      LIMIT ?
    `,
      [chatId, types.Long.fromNumber(after), limit + 1],
      { ...QUORUM_READ, fetchSize: limit + 1 },
    );

    const selectedRows = chainResult.rows.slice(0, limit);
    if (selectedRows.length === 0)
      return { entries: [], nextAfter: after, hasMore: false };

    const positions = selectedRows.map((row, index) => {
      const chatSeq = positiveSequence(row.get('chat_seq'));
      const messageId = String(row.get('message_id'));
      const chainHash: unknown = row.get('chain_hash');
      const messageHash: unknown = row.get('message_hash');
      if (
        chatSeq !== after + index + 1 ||
        !TIME_UUID.test(messageId) ||
        typeof chainHash !== 'string' ||
        !HASH.test(chainHash) ||
        typeof messageHash !== 'string' ||
        !HASH.test(messageHash)
      ) {
        throw new ServiceUnavailableException('CHAT_CHAIN_PAGE_INCONSISTENT');
      }

      return {
        chatSeq,
        messageId,
        chainHash,
        messageHash,
      };
    });

    const messagesResult = await this.cassandra.client.execute(
      `
      SELECT
        message_id,
        sender_id,
        sender_device_id,
        type,
        envelope,
        seq,
        prev_hash,
        signature,
        chat_seq,
        chain_hash,
        message_hash,
        created_at
      FROM messages
      WHERE chat_id = ? AND message_id IN ?
    `,
      [
        chatId,
        positions.map((position) =>
          types.TimeUuid.fromString(position.messageId),
        ),
      ],
      { ...QUORUM_READ, fetchSize: limit },
    );

    const rowById = new Map<string, types.Row>(
      messagesResult.rows.map((row) => [String(row.get('message_id')), row]),
    );
    const messages = positions.map((position) => {
      const row = rowById.get(position.messageId);
      if (!row) {
        throw new ServiceUnavailableException('MESSAGE_COMMIT_NOT_CONFIRMED');
      }

      const message = this.restore(row, chatId, position.messageId);
      if (
        message.chatSeq !== position.chatSeq ||
        message.chainHash !== position.chainHash ||
        message.messageHash !== position.messageHash
      ) {
        throw new ServiceUnavailableException(
          'MESSAGE_CHAIN_POSITION_MISMATCH',
        );
      }

      return message;
    });

    for (let offset = 0; offset < messages.length; offset += 4) {
      await Promise.all(
        messages
          .slice(offset, offset + 4)
          .map((message) => this.assertCommitted(message)),
      );
    }

    const entries: EncryptedSyncEntry[] = messages.map((message) => {
      const addressedToUser =
        message.senderId === userId ||
        message.envelope.recipients.some(
          (recipient) => recipient.userId === userId,
        );

      return {
        chatSeq: message.chatSeq,
        chainHash: message.chainHash,
        messageHash: message.messageHash,
        message: addressedToUser ? message : null,
      };
    });

    return {
      entries,
      nextAfter: positions[positions.length - 1]!.chatSeq,
      hasMore: chainResult.rows.length > limit,
    };
  }

  private async assertCommitted(
    message: EncryptedMessageResponse,
  ): Promise<void> {
    const result = await this.cassandra.client.execute(
      `
      SELECT
        state,
        sender_id,
        message_id,
        message_hash,
        signature
      FROM e2e_send_operations
      WHERE chat_id = ?
        AND sender_device_id = ?
        AND seq = ?
    `,
      [
        message.chatId,
        message.senderDeviceId,
        types.Long.fromNumber(message.seq),
      ],
      {
        prepare: true,
        consistency: types.consistencies.localSerial,
      },
    );

    const operation = result.first();

    if (
      !operation ||
      operation.get('state') !== 'COMMITTED' ||
      String(operation.get('sender_id')) !== message.senderId ||
      String(operation.get('message_id')) !== message.messageId ||
      operation.get('message_hash') !== message.messageHash ||
      operation.get('signature') !== message.signature
    ) {
      throw new ServiceUnavailableException('MESSAGE_COMMIT_NOT_CONFIRMED');
    }
  }

  private restore(
    row: types.Row,
    chatId: string,
    messageId: string,
  ): EncryptedMessageResponse {
    try {
      if (row.get('type') !== 'e2e_v1') return invalidRecord();

      const senderId = String(row.get('sender_id'));
      const seq = positiveSequence(row.get('seq'));
      const chatSeq = positiveSequence(row.get('chat_seq'));

      const storedEnvelope: unknown = row.get('envelope');
      const chainHash: unknown = row.get('chain_hash');
      const createdAt: unknown = row.get('created_at');
      if (
        typeof chainHash !== 'string' ||
        !HASH.test(chainHash) ||
        !(createdAt instanceof Date) ||
        createdAt.getTime() !==
          types.TimeUuid.fromString(messageId).getDate().getTime()
      )
        return invalidRecord();

      const prepared = prepareEncryptedMessage(senderId, {
        chatId,
        senderDeviceId: String(row.get('sender_device_id')),
        seq,
        prevHash: row.get('prev_hash') as unknown,
        signature: row.get('signature') as unknown,
        envelope: decodeEnvelope(storedEnvelope),
      });

      if (
        prepared.serializedEnvelope !== storedEnvelope ||
        prepared.messageHash !== row.get('message_hash')
      )
        return invalidRecord();

      return {
        ...prepared.message,
        messageId,
        senderId,
        type: 'e2e_v1',
        chatSeq,
        chainHash,
        messageHash: prepared.messageHash,
        createdAt: createdAt.toISOString(),
      };
    } catch {
      return invalidRecord();
    }
  }
}
