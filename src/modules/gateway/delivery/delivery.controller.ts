import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { ChatGateway } from '../chat.gateway';
import { RedisService } from '@common/redis/redis.service';

interface MessageSentEvent {
  chatId: string;
  messageId: string;
  senderId: string;
  content?: string;
  attachments?: unknown[];
  type: string;
  createdAt: Date;
  recipientIds: string[];
  viaAssistant?: boolean;
}

interface MessageReactionEvent {
  chatId: string;
  messageId: string;
  userId: string;
  emoji?: string;
  action: 'add' | 'remove';
  recipientIds: string[];
}

interface ChatReadEvent {
  chatId: string;
  userId: string;
  lastReadMessageId: string;
  recipientIds: string[];
}

@Controller()
export class DeliveryController {
  private readonly logger = new Logger(DeliveryController.name);

  constructor(
    private readonly chatGateway: ChatGateway,
    private readonly redisService: RedisService,
  ) {}

  @EventPattern('message.sent')
  handleMessageSent(): void {}

  @EventPattern('message.reaction')
  async handleMessageReaction(@Payload() event: MessageReactionEvent) {
    await this.fanOut(event.recipientIds, 'reaction', event);
    this.logger.log(
      `Реакция ${event.action} разослана по чату ${event.chatId}`,
    );
  }

  @EventPattern('chat.read')
  async handleChatRead(@Payload() event: ChatReadEvent) {
    const recipients = event.recipientIds.filter((id) => id !== event.userId);
    await this.fanOut(recipients, 'read', event);
  }

  private async fanOut(
    recipientIds: string[],
    eventName: string,
    payload: unknown,
  ): Promise<void> {
    const pipeline = this.redisService.client.pipeline();
    for (const userId of recipientIds) {
      pipeline.smembers(`user_sockets:${userId}`);
    }

    const results: [Error | null, unknown][] | null = await pipeline.exec();
    let totalSockets = 0;

    (results ?? []).forEach(([err, socketIds], index) => {
      if (err) {
        this.logger.error(
          `Не удалось получить сокеты userId=${recipientIds[index]}: ${err}`,
        );
        return;
      }

      const ids: string[] = (socketIds as string[] | null) ?? [];

      for (const socketId of ids) {
        this.chatGateway.server.to(socketId).emit(eventName, payload);
      }
      totalSockets += ids.length;
    });

    this.logger.log(
      `Событие ${eventName}: получателей=${recipientIds.length}, сокетов=${totalSockets}`,
    );
  }
}
