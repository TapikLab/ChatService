import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect } from 'amqp-connection-manager';
import type {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import type { Message } from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { StoredEncryptedMessage } from '@modules/message-writer/send/encrypted-writer-store.service';

const CHAT_QUEUE = 'tapik.e2e.chat.v1';
const NOTIFICATION_QUEUE = 'tapik.e2e.notifications.v1';

@Injectable()
export class EncryptedEventPublisher
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(EncryptedEventPublisher.name);
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;
  private ready = false;
  private readonly attempts = new Map<string, { returned: boolean }>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (this.config.getOrThrow<string>('OUTBOX_WORKER_ENABLED') !== 'true')
      return;

    this.connection = connect(
      [this.config.getOrThrow<string>('RABBITMQ_URL')],
      {
        heartbeatIntervalInSeconds: 5,
        reconnectTimeInSeconds: 5,
      },
    );

    this.connection.on('disconnect', () => {
      this.ready = false;
    });

    this.channel = this.connection.createChannel({
      name: 'e2e-outbox-publisher',
      confirm: true,
      json: true,
      publishTimeout: 5_000,
      setup: async (channel) => {
        this.ready = false;

        channel.on('return', (message: Message) => {
          const attemptId = message.properties.correlationId;
          if (typeof attemptId !== 'string') return;

          const attept = this.attempts.get(attemptId);
          if (attept) attept.returned = true;
        });

        await channel.assertExchange('tapik.e2e.dead', 'direct', {
          durable: true,
        });

        await channel.assertQueue('tapik.e2e.failed.v1', {
          durable: true,
          autoDelete: false,
          arguments: {
            'x-queue-type': 'quorum',
            'x-overflow': 'reject-publish',
          },
        });

        await channel.bindQueue(
          'tapik.e2e.failed.v1',
          'tapik.e2e.dead',
          'failed',
        );

        for (const queue of [CHAT_QUEUE, NOTIFICATION_QUEUE]) {
          await channel.assertQueue(queue, {
            durable: true,
            autoDelete: false,
            arguments: {
              'x-queue-type': 'quorum',
              'x-overflow': 'reject-publish',
            },
          });
        }
      },
    });

    this.channel.on('connect', () => {
      this.ready = true;
    });

    this.channel.on('error', () => {
      ((this.ready = false),
        this.logger.error('E2EE_PUBLISHER_CHANNEL_FAILED'));
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  async publish(message: StoredEncryptedMessage): Promise<void> {
    const eventId = `e2e:${message.chatId}:${message.messageId}`;
    const { replayed, ...storedMessage } = message;
    void replayed;

    await this.sendConfirmed(CHAT_QUEUE, eventId, {
      pattern: 'message.e2e.committed',
      data: {
        eventId,
        message: storedMessage,
      },
    });

    if (
      message.envelope.mode === 'e2e_group_v1' &&
      message.envelope.kind === 'distribution'
    )
      return;

    const recipientIds = [
      ...new Set(
        message.envelope.recipients
          .map((recipient) => recipient.userId)
          .filter((userId) => userId !== message.senderId),
      ),
    ];
    if (recipientIds.length > 0) {
      await this.sendConfirmed(NOTIFICATION_QUEUE, eventId, {
        pattern: 'message.e2e.notify',
        data: {
          eventId,
          chatId: message.chatId,
          messageId: message.messageId,
          senderId: message.senderId,
          createdAt: message.createdAt,
          recipientIds,
        },
      });
    }
  }

  private async sendConfirmed(
    queue: string,
    eventId: string,
    payload: unknown,
  ): Promise<void> {
    const channel = this.channel;
    if (!channel || !this.ready) {
      throw new ServiceUnavailableException('E2EE_BROKER_UNAVAILABLE');
    }

    const attemptId = randomUUID();
    const attempt = { returned: false };

    this.attempts.set(attemptId, attempt);
    try {
      await channel.sendToQueue(queue, payload, {
        persistent: true,
        mandatory: true,
        messageId: eventId,
        correlationId: attemptId,
        contentType: 'application/json',
      });

      if (attempt.returned) {
        throw new ServiceUnavailableException('E2EE_EVENT_UNROUTABLE');
      }
    } finally {
      this.attempts.delete(attemptId);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.ready = false;
    if (this.connection) await this.connection.close();
  }
}
