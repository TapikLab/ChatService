import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { types } from 'cassandra-driver';
import { SendMessageDto } from './dto/send-message.dto';
import { WriterTransportService } from '@modules/message-writer/writer-transport.service';
import {
  isServiceMessageType,
  type SignedProof,
} from '@modules/message-writer/contract';
import { readCheckpoint } from './signing/checkpoint';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatsService } from '@modules/chats/chats.service';
import {
  MediaClientService,
  MediaUrlLookup,
} from '@modules/media-client/media-client.service';

interface StoredAttachment {
  media_id: string;
  url: string;
  type: string;
  file_name: string | null;
  size_byte: number | null;
  placeholder: string | null;
}

export type SignedMessageMeta = SignedProof;

@Injectable()
export class MessagesService {
  constructor(
    private readonly mediaClient: MediaClientService,
    private readonly cassandra: CassandraService,
    private readonly chatsService: ChatsService,
    private readonly writer: WriterTransportService,
    @Inject('RABBITMQ_SERVICE') private readonly rabbitClient: ClientProxy,
    @Inject('NOTIFICATION_SERVICE')
    private readonly notificationClient: ClientProxy,
    @Inject('ASSISTANT_SERVICE') private readonly assistantClient: ClientProxy,
  ) {}

  async sendMessage(
    senderId: string,
    dto: SendMessageDto,
    viaAssistant = false,
    signed?: SignedMessageMeta,
  ) {
    if (!dto.content && (!dto.attachments || dto.attachments.length === 0)) {
      throw new BadRequestException(
        'Сообщение должно содержать текст или хотя бы одно вложение',
      );
    }

    await this.chatsService.assertMember(dto.chatId, senderId);

    let checkpoint: ReturnType<typeof readCheckpoint>;
    try {
      checkpoint = readCheckpoint(dto.content);
    } catch (error) {
      throw new BadRequestException('INVALID_CHECKPOINT');
    }

    if (checkpoint && (!signed || viaAssistant || dto.attachments?.length)) {
      throw new BadRequestException('INVALID_CHECKPOINT_MESSAGE');
    }

    if (dto.attachments?.length) {
      const verifications = await Promise.all(
        dto.attachments.map((attachment) =>
          this.mediaClient.verifyMedia(attachment.mediaId, senderId),
        ),
      );

      dto.attachments.forEach((attachment, index) => {
        const verified = verifications[index];
        if (!verified.valid) {
          throw new BadRequestException(
            `Вложение ${attachment.mediaId} не найдено или не принадлежит вам`,
          );
        }
        attachment.url = verified.url;
        attachment.placeholder = verified.placeholder;
      });
    }

    const saved = await this.writer.append({
      version: 1,
      senderId,
      message: {
        chatId: dto.chatId,
        content: dto.content,
        attachments: dto.attachments,
      },
      viaAssistant,
      signed,
      ...(signed ? {} : { messageId: types.TimeUuid.now().toString() }),
    });
    if (saved.replayed) return saved;

    const recipientIds = await this.chatsService.getMemberIds(dto.chatId);
    this.rabbitClient.emit('message.sent', { ...saved, recipientIds });

    if (!isServiceMessageType(saved.type)) {
      this.notificationClient.emit('message.sent', {
        chatId: saved.chatId,
        senderId: saved.senderId,
        content: saved.content,
        recipientIds,
      });
      this.assistantClient.emit('message.sent', {
        chatId: saved.chatId,
        messageId: saved.messageId,
        senderId: saved.senderId,
        content: saved.content,
        recipientIds,
        viaAssistant: saved.viaAssistant,
      });
    }
    return saved;
  }

  async getChain(
    chatId: string,
    userId: string,
    limit = 100,
    beforeChatSeq?: number,
  ) {
    await this.chatsService.assertMember(chatId, userId);

    const params: unknown[] = [chatId];
    let query = `SELECT chat_seq, message_id, message_hash, chain_hash, kind
                 FROM chat_chain_log WHERE chat_id = ?`;

    if (beforeChatSeq !== undefined) {
      query += ` AND chat_seq < ?`;
      params.push(types.Long.fromNumber(beforeChatSeq));
    }
    query += ` LIMIT ?`;
    params.push(limit);

    const result = await this.cassandra.client.execute(query, params, {
      prepare: true,
    });

    return {
      entries: result.rows.map((row) => ({
        chatSeq: (row.get('chat_seq') as types.Long).toNumber(),
        messageId: String(row.get('message_id')),
        messageHash: row.get('message_hash') as string,
        chainHash: row.get('chain_hash') as string,
        kind: row.get('kind') as string,
      })),
    };
  }

  async getHistory(
    chatId: string,
    userId: string,
    limit = 50,
    beforeMessageId?: string,
  ): Promise<Record<string, unknown>[]> {
    await this.chatsService.assertMember(chatId, userId);

    const params: unknown[] = [chatId];
    let query = `SELECT * FROM messages WHERE chat_id = ?`;
    if (beforeMessageId) {
      query += ` AND message_id < ?`;
      params.push(types.TimeUuid.fromString(beforeMessageId));
    }
    query += ` LIMIT ?`;
    params.push(limit);

    const result = await this.cassandra.client.execute(query, params, {
      prepare: true,
    });

    const mediaIds: string[] = [
      ...new Set(
        result.rows.flatMap((row) =>
          ((row.get('attachments') as StoredAttachment[] | null) ?? []).map(
            (attachment) => attachment.media_id,
          ),
        ),
      ),
    ];

    const urlById: Map<string, MediaUrlLookup> = mediaIds.length
      ? await this.mediaClient.getMediaUrls(mediaIds)
      : new Map<string, MediaUrlLookup>();

    return result.rows.map((row) => ({
      ...row,
      editOf: row.get('edit_of') ? String(row.get('edit_of')) : null,
      chatId: String(row.get('chat_id')),
      messageId: String(row.get('message_id')),
      senderId: String(row.get('sender_id')),
      chatSeq: (row.get('chat_seq') as types.Long | null)?.toNumber() ?? null,
      chainHash: (row.get('chain_hash') as string | null) ?? null,
      messageHash: (row.get('message_hash') as string | null) ?? null,
      seq: (row.get('seq') as types.Long | null)?.toNumber() ?? null,
      senderDeviceId: row.get('sender_device_id')
        ? String(row.get('sender_device_id'))
        : null,
      prevHash: (row.get('prev_hash') as string | null) ?? null,
      signature: (row.get('signature') as string | null) ?? null,
      attachments: (
        (row.get('attachments') as StoredAttachment[] | null) ?? []
      ).map((attachment) => {
        const lookup = urlById.get(attachment.media_id);
        const isAvailable = lookup?.isAvailable ?? false;
        return {
          ...attachment,
          mediaId: String(attachment.media_id),
          url: isAvailable ? (lookup?.url ?? null) : null,
          isAvailable,
        };
      }),
    }));
  }
}
