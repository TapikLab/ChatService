import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HASH, UUID, type AppendCommand, type StoredMessage } from './contract';

@Injectable()
export class WriterTransportService {
  private readonly endpoint: URL;
  private readonly token: string;
  constructor(config: ConfigService) {
    this.endpoint = new URL(
      '/internal/messages/append',
      config.getOrThrow<string>('MESSAGE_WRITER_URL'),
    );
    if (
      this.endpoint.username ||
      this.endpoint.password ||
      (this.endpoint.protocol !== 'https:' &&
        !(
          this.endpoint.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname)
        ))
    )
      throw new Error('WRITER_HTTPS_OR_LOOPBACK_REQUIRED');

    this.token = config.getOrThrow<string>('MESSAGE_WRITER_TOKEN');
    if (!/^[0-9a-f]{64}$/.test(this.token))
      throw new Error('INVALID_WRITER_TOKEN');
  }

  async append(command: AppendCommand): Promise<StoredMessage> {
    const body = JSON.stringify(command);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          await response.arrayBuffer();
          if ([400, 403, 404, 409].includes(response.status)) {
            throw new HttpException('MESSAGE_WRITER_REJECTED', response.status);
          }
          throw new Error('WRITER_UNAVAILABLE');
        }
        const value: unknown = await response.json();
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('INVALID_WRITER_REPLY');

        const reply = value as Record<string, unknown>;
        if (
          reply.chatId !== command.message.chatId ||
          reply.senderId !== command.senderId ||
          typeof reply.messageId !== 'string' ||
          !UUID.test(reply.messageId) ||
          (command.messageId !== undefined &&
            reply.messageId !== command.messageId) ||
          reply.content !== command.message.content ||
          typeof reply.chatSeq !== 'number' ||
          !Number.isSafeInteger(reply.chatSeq) ||
          reply.chatSeq < 1 ||
          typeof reply.chainHash !== 'string' ||
          !HASH.test(reply.chainHash) ||
          typeof reply.type !== 'string' ||
          typeof reply.replayed !== 'boolean' ||
          !Array.isArray(reply.attachments) ||
          typeof reply.createdAt !== 'string'
        )
          throw new Error('INVALID_WRITER_REPLY');

        return value as StoredMessage;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        if (attempt === 2)
          throw new ServiceUnavailableException('MESSAGE_WRITER_UNAVAILABLE');
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 100 * 2 ** attempt),
      );
    }
    throw new ServiceUnavailableException('MESSAGE_WRITER_UNAVAILABLE');
  }
}
