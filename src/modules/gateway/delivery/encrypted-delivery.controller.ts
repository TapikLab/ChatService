import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import type { Channel, ConsumeMessage } from 'amqplib';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatGateway } from '@modules/gateway/chat.gateway';
import { prepareEncryptedMessage } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { ChatAccessService } from '@modules/chat-access/chat-access.service';

const MAX_EVENT_BYTES = 256 * 1024;
const MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface MessageAvailable {
  readonly eventId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly chatSeq: number;
}

interface ParsedDelivery {
  readonly notification: MessageAvailable;
  readonly userIds: readonly string[];
}

function invalidEvent(): never {
  throw new Error('INVALID_E2EE_DELIVERY_EVENT');
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidEvent();
  }

  return value as Record<string, unknown>;
}

function parsedDelivery(value: unknown): ParsedDelivery {
  const event = object(value);
  const message = object(event.message);
  if (message.type !== 'e2e_v1' || typeof message.senderId !== 'string')
    return invalidEvent();

  const prepared = prepareEncryptedMessage(message.senderId, {
    chatId: message.chatId,
    senderDeviceId: message.senderDeviceId,
    seq: message.seq,
    prevHash: message.prevHash,
    signature: message.signature,
    envelope: message.envelope,
  });
  if (message.messageHash !== prepared.messageHash) return invalidEvent();

  const messageId = message.messageId;
  const chatSeq = message.chatSeq;
  if (
    typeof messageId !== 'string' ||
    messageId.length !== 36 ||
    !MESSAGE_ID_PATTERN.test(messageId) ||
    typeof chatSeq !== 'number' ||
    !Number.isSafeInteger(chatSeq) ||
    chatSeq < 1
  )
    return invalidEvent();

  const chatId = prepared.message.chatId;
  const eventId = `e2e:${chatId}:${messageId}`;
  if (event.eventId !== eventId) return invalidEvent();

  const userIds = new Set<string>([message.senderId]);
  for (const recipient of prepared.message.envelope.recipients) {
    userIds.add(recipient.userId);
  }

  return {
    notification: {
      eventId,
      chatId,
      messageId,
      chatSeq,
    },
    userIds: [...userIds],
  };
}

@Controller()
export class EncryptedDeliveryController {
  private readonly logger = new Logger(EncryptedDeliveryController.name);

  constructor(
    private readonly access: ChatAccessService,
    private readonly gateway: ChatGateway,
  ) {}

  @EventPattern('message.e2e.committed')
  async handleCommitted(
    @Payload() payload: unknown,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef() as Channel;
    const delivery = context.getMessage() as ConsumeMessage;

    let event: ParsedDelivery;
    try {
      if (delivery.content.length > MAX_EVENT_BYTES) invalidEvent();
      event = parsedDelivery(payload);
    } catch {
      this.logger.error('E2EE_DELIVERY_INVALID_EVENT');
      channel.reject(delivery, false);
      return;
    }

    try {
      await this.dispatch(event);
    } catch {
      this.logger.warn('E2EE_DELIVERY_RETRY');
      await delay(1_000);

      channel.reject(delivery, true);
      return;
    }

    channel.ack(delivery);
  }

  private async dispatch(event: ParsedDelivery): Promise<void> {
    const userIds = await this.access.selectMembers(
      event.notification.chatId,
      event.userIds,
    );

    if (userIds.length === 0) return;

    const rooms = userIds.map((userId) => `user:${userId}`);

    this.gateway.server
      .to(rooms)
      .emit('message.e2e.available', event.notification);
  }
}
