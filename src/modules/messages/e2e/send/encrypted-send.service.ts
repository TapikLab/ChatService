import { WriterTransport } from '@modules/message-writer/client/writer-transport';
import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { prepareEncryptedMessage } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import type { EncryptedSendReceipt } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { mapWriterSendError, unknownSendOutcome } from './encrypted-send-error';

const TIME_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HASH = /^[0-9a-f]{64}$/;
@Injectable()
export class EncryptedSendService {
  private readonly transport: WriterTransport;

  constructor(config: ConfigService) {
    this.transport = new WriterTransport(config);
  }

  async send(senderId: string, body: unknown): Promise<EncryptedSendReceipt> {
    const prepared = prepareEncryptedMessage(senderId, body);
    try {
      const { response, value } = await this.transport.post(
        '/internal/messages/append-encrypted',
        { senderId, message: prepared.message },
      );

      if (!response.ok) {
        throw mapWriterSendError(response.status, value);
      }

      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('INVALID_WRITER_REPLY');
      }

      const reply = value as Record<string, unknown>;
      if (
        Object.keys(reply).length !== 6 ||
        reply.chatId !== prepared.message.chatId ||
        reply.messageHash !== prepared.messageHash ||
        typeof reply.messageId !== 'string' ||
        !TIME_UUID.test(reply.messageId) ||
        typeof reply.chatSeq !== 'number' ||
        !Number.isSafeInteger(reply.chatSeq) ||
        reply.chatSeq < 1 ||
        typeof reply.chainHash !== 'string' ||
        !HASH.test(reply.chainHash) ||
        typeof reply.replayed !== 'boolean'
      ) {
        throw new Error('INVALID_WRITER_REPLY');
      }

      return {
        chatId: prepared.message.chatId,
        messageId: reply.messageId,
        messageHash: prepared.messageHash,
        chatSeq: reply.chatSeq,
        chainHash: reply.chainHash,
        replayed: reply.replayed,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw unknownSendOutcome();
    }
  }
}
