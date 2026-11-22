import {
  ConflictException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import {
  prepareEncryptedMessage,
  type PreparedEncryptedMessage,
} from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import type { ChatAdmissionReceipt } from '@modules/message-writer/admission/chat-admission.contract';
import type { ValidatedEncryptedMessage } from './encrypted-message-validator.service';

export interface PreparedSendCandidate {
  readonly state: 'PREPARED';
  readonly senderId: string;
  readonly messageId: string;
  readonly prepared: PreparedEncryptedMessage;
}

const SERIAL_READ = {
  prepare: true,
  consistency: types.consistencies.localSerial,
};

const CAS_WRITE = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  serialConsistency: types.consistencies.localSerial,
  isIdempotent: false,
};

@Injectable()
export class EncryptedSendCandidatesService implements OnModuleInit {
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
      [this.cassandra.client.keyspace, 'e2e_send_candidates'],
      { prepare: true },
    );

    if (result.first()?.get('default_time_to_live') !== 0) {
      throw new Error('NON_EXPIRING_TABLE_REQUIRED:e2e_send_candidates');
    }
  }

  async saveCandidate(
    validated: ValidatedEncryptedMessage,
  ): Promise<PreparedSendCandidate> {
    const { senderId, prepared } = validated;
    const { message } = prepared;
    const existing = await this.read(prepared);
    if (existing) {
      return this.restore(existing, validated);
    }

    const messageId = types.TimeUuid.now();
    const requestJson = JSON.stringify(message);

    let outcomeUnknown = false;
    try {
      await this.cassandra.client.execute(
        `
          INSERT INTO e2e_send_candidates (
            chat_id,
            sender_device_id,
            seq,
            message_hash,
            sender_id,
            message_id,
            signature,
            request_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          IF NOT EXISTS
        `,
        [
          message.chatId,
          message.senderDeviceId,
          types.Long.fromNumber(message.seq),
          prepared.messageHash,
          senderId,
          messageId,
          message.signature,
          requestJson,
        ],
        CAS_WRITE,
      );
    } catch {
      outcomeUnknown = true;
    }

    const stored = await this.read(prepared);
    if (!stored) {
      throw new ServiceUnavailableException(
        outcomeUnknown
          ? 'SEND_PREPARATION_OUTCOME_UNKNOWN'
          : 'SEND_CANDIDATE_NOT_VISIBLE',
      );
    }

    return this.restore(stored, validated);
  }

  async readAcceptedCandidate(
    chatId: string,
    entryKey: string,
  ): Promise<{
    readonly receipt: ChatAdmissionReceipt;
    readonly candidate: PreparedSendCandidate;
  } | null> {
    const receipt = await this.admission.readReceipt(chatId, entryKey);
    if (!receipt) return null;

    if (receipt.commandKind !== 'SEND') {
      throw new ConflictException('SEND_RECEIPT_REQUIRED');
    }

    const parts = receipt.entryKey.split(':');
    const senderDeviceId = parts[1];
    const seq = Number(parts[2]);

    let row = await this.readRegisteredRequest(receipt, senderDeviceId, seq);
    if (!row) {
      try {
        const result = await this.cassandra.client.execute(
          `
          SELECT
            sender_id,
            message_id,
            signature,
            request_json
          FROM e2e_send_candidates
          WHERE chat_id = ?
            AND sender_device_id = ?
            AND seq = ?
            AND message_hash = ?
        `,
          [
            receipt.chatId,
            senderDeviceId,
            types.Long.fromNumber(seq),
            receipt.requestHash,
          ],
          SERIAL_READ,
        );

        row = result.first() ?? null;
      } catch {
        throw new ServiceUnavailableException(
          'SEND_CANDIDATE_READ_UNAVAILABLE',
        );
      }

      if (!row || row.get('request_json') == null) {
        row = await this.readRegisteredRequest(receipt, senderDeviceId, seq);
      }
    }

    if (!row) {
      throw new ServiceUnavailableException('ACCEPTED_SEND_REQUEST_MISSING');
    }

    try {
      const storedSenderId: unknown = row.get('sender_id');
      const storedMessageId: unknown = row.get('message_id');
      const storedSignature: unknown = row.get('signature');
      const storedRequestJson: unknown = row.get('request_json');
      if (
        !(storedSenderId instanceof types.Uuid) ||
        !(storedMessageId instanceof types.TimeUuid) ||
        storedSenderId.toString() !== receipt.actorId ||
        typeof storedRequestJson !== 'string' ||
        storedRequestJson.length === 0 ||
        storedRequestJson.length > 256 * 1024
      ) {
        throw new Error('INVALID_CANDIDATE_RECORD');
      }

      const body: unknown = JSON.parse(storedRequestJson);
      const prepared = prepareEncryptedMessage(receipt.actorId, body);
      const { message } = prepared;
      if (
        message.chatId !== receipt.chatId ||
        message.senderDeviceId !== senderDeviceId ||
        message.seq !== seq ||
        prepared.messageHash !== receipt.requestHash ||
        message.signature !== storedSignature ||
        JSON.stringify(message) !== storedRequestJson
      ) {
        throw new Error('CANDIDATE_RECEIPT_MISMATCH');
      }

      const candidate: PreparedSendCandidate = Object.freeze({
        state: 'PREPARED',
        senderId: receipt.actorId,
        messageId: storedMessageId.toString(),
        prepared,
      });

      return Object.freeze({
        receipt,
        candidate,
      });
    } catch {
      throw new ServiceUnavailableException('INVALID_ACCEPTED_SEND_CANDIDATE');
    }
  }

  async retireCommittedCandidate(
    chatId: string,
    entryKey: string,
  ): Promise<void> {
    const accepted = await this.readAcceptedCandidate(chatId, entryKey);
    if (!accepted) {
      throw new ServiceUnavailableException(
        'SEND_RECEIPT_REQUIRED_FOR_CLEANUP',
      );
    }

    const { candidate } = accepted;
    const { message } = candidate.prepared;

    let operation: types.Row | null;
    try {
      const result = await this.cassandra.client.execute(
        `
        SELECT
          sender_id,
          message_id,
          message_hash,
          signature,
          request_json,
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

      operation = result.first() ?? null;
    } catch {
      throw new ServiceUnavailableException(
        'CANDIDATE_CLEANUP_CHECK_UNAVAILABLE',
      );
    }

    if (
      !operation ||
      operation.get('state') !== 'COMMITTED' ||
      String(operation.get('sender_id')) !== candidate.senderId ||
      String(operation.get('message_id')) !== candidate.messageId ||
      operation.get('message_hash') !== candidate.prepared.messageHash ||
      operation.get('signature') !== message.signature ||
      operation.get('request_json') !== JSON.stringify(message)
    ) {
      throw new ServiceUnavailableException('CANDIDATE_CLEANUP_NOT_CONFIRMED');
    }

    try {
      await this.cassandra.client.execute(
        `
        INSERT INTO e2e_send_candidates (
          chat_id,
          sender_device_id,
          seq,
          message_hash,
          sender_id,
          message_id,
          signature
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        IF NOT EXISTS
      `,
        [
          message.chatId,
          message.senderDeviceId,
          types.Long.fromNumber(message.seq),
          candidate.prepared.messageHash,
          candidate.senderId,
          types.TimeUuid.fromString(candidate.messageId),
          message.signature,
        ],
        CAS_WRITE,
      );

      await this.cassandra.client.execute(
        `
          UPDATE e2e_send_candidates
          SET request_json = null
          WHERE chat_id = ?
            AND sender_device_id = ?
            AND seq = ?
            AND message_hash = ?
          IF sender_id = ?
            AND message_id = ?
            AND signature = ?
        `,
        [
          message.chatId,
          message.senderDeviceId,
          types.Long.fromNumber(message.seq),
          candidate.prepared.messageHash,
          candidate.senderId,
          types.TimeUuid.fromString(candidate.messageId),
          message.signature,
        ],
        CAS_WRITE,
      );
    } catch {}

    const marker = await this.read(candidate.prepared);
    if (
      !marker ||
      String(marker.get('sender_id')) !== candidate.senderId ||
      String(marker.get('message_id')) !== candidate.messageId ||
      marker.get('signature') !== message.signature ||
      marker.get('request_json') != null
    ) {
      throw new ServiceUnavailableException(
        'CANDIDATE_RETIREMENT_NOT_CONFIRMED',
      );
    }
  }

  private async readRegisteredRequest(
    receipt: ChatAdmissionReceipt,
    senderDeviceId: string,
    seq: number,
  ): Promise<types.Row | null> {
    let row: types.Row | null;
    try {
      const result = await this.cassandra.client.execute(
        `
        SELECT
          sender_id,
          message_id,
          message_hash,
          signature,
          request_json,
          state
        FROM e2e_send_operations
        WHERE chat_id = ?
          AND sender_device_id = ?
          AND seq = ?
      `,
        [receipt.chatId, senderDeviceId, types.Long.fromNumber(seq)],
        SERIAL_READ,
      );

      row = result.first() ?? null;
    } catch {
      throw new ServiceUnavailableException(
        'REGISTERED_SEND_REQUEST_UNAVAILABLE',
      );
    }

    if (!row) return null;

    const state: unknown = row.get('state');
    if (
      (state !== 'REGISTERED' && state !== 'COMMITTED') ||
      String(row.get('sender_id')) !== receipt.actorId ||
      row.get('message_hash') !== receipt.requestHash
    ) {
      throw new ServiceUnavailableException('REGISTERED_SEND_RECEIPT_MISMATCH');
    }

    return row;
  }

  private async read(
    prepared: PreparedEncryptedMessage,
  ): Promise<types.Row | null> {
    const { message } = prepared;
    try {
      const result = await this.cassandra.client.execute(
        `
          SELECT
            sender_id,
            message_id,
            signature,
            request_json
          FROM e2e_send_candidates
          WHERE chat_id = ?
            AND sender_device_id = ?
            AND seq = ?
            AND message_hash = ?
        `,
        [
          message.chatId,
          message.senderDeviceId,
          types.Long.fromNumber(message.seq),
          prepared.messageHash,
        ],
        SERIAL_READ,
      );

      return result.first() ?? null;
    } catch {
      throw new ServiceUnavailableException('SEND_CANDIDATE_READ_UNAVAILABLE');
    }
  }

  private async restore(
    row: types.Row,
    validated: ValidatedEncryptedMessage,
  ): Promise<PreparedSendCandidate> {
    const { senderId, prepared } = validated;
    const storedMessageId = row.get('message_id');
    const storedRequest: unknown = row.get('request_json');

    if (!(storedMessageId instanceof types.TimeUuid)) {
      throw new ServiceUnavailableException('INVALID_SEND_CANDIDATE');
    }

    if (
      String(row.get('sender_id')) !== senderId ||
      row.get('signature') !== prepared.message.signature
    ) {
      throw new ConflictException('SEND_CANDIDATE_REUSED');
    }

    if (storedRequest == null) {
      const { message } = prepared;
      const accepted = await this.readAcceptedCandidate(
        message.chatId,
        `send:${message.senderDeviceId}:${message.seq}`,
      );

      if (!accepted) {
        throw new ServiceUnavailableException(
          'RETIRED_CANDIDATE_WITHOUT_RECEIPT',
        );
      }

      const restored = accepted.candidate;
      if (
        restored.senderId !== senderId ||
        restored.messageId !== storedMessageId.toString() ||
        restored.prepared.messageHash !== prepared.messageHash ||
        restored.prepared.message.signature !== message.signature ||
        JSON.stringify(restored.prepared.message) !== JSON.stringify(message)
      ) {
        throw new ConflictException('SEND_CANDIDATE_REUSED');
      }

      return restored;
    }

    if (storedRequest !== JSON.stringify(prepared.message)) {
      throw new ConflictException('SEND_CANDIDATE_REUSED');
    }

    return Object.freeze({
      state: 'PREPARED',
      senderId,
      messageId: storedMessageId.toString(),
      prepared,
    });
  }
}
