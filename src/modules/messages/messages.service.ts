import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { types } from 'cassandra-driver';
import { SendMessageDto } from './dto/send-message.dto';
import { ChatChainService } from './signing/chat-chain.service';
import { computeServerMessageHash } from './signing/chain-hash';
import { computeContentHash } from './signing/message-signature';
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

export interface SignedMessageMeta {
  senderDeviceId: string;
  seq: number;
  prevHash: string;
  messageHash: string;
  signature: string;
  claimChain: () => Promise<types.TimeUuid>;
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly mediaClient: MediaClientService,
    private readonly cassandra: CassandraService,
    private readonly chatsService: ChatsService,
    private readonly chatChain: ChatChainService,
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

    const type = dto.attachments?.length
      ? dto.content
        ? 'mixed'
        : dto.attachments[0].type
      : 'text';

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

    const messageId = signed ? await signed.claimChain() : types.TimeUuid.now();
    const createdAt = signed ? messageId.getDate() : new Date();

    if (signed) {
      const stored = await this.findStoredMessage(dto.chatId, messageId);
      if (stored) {
        return {
          chatId: dto.chatId,
          messageId: messageId.toString(),
          senderId,
          content: dto.content,
          type,
          attachment: dto.attachments,
          createdAt,
          chatSeq: stored.chatSeq,
          chainHash: stored.chainHash,
          replayed: true,
        };
      }
    }

    const messageHash = signed
      ? signed.messageHash
      : computeServerMessageHash({
          chatId: dto.chatId,
          messageId: messageId.toString(),
          senderId: senderId,
          contentHash: computeContentHash(dto.content, dto.attachments),
        });

    const { chatSeq, chainHash } = await this.chatChain.append({
      chatId: dto.chatId,
      messageId,
      messageHash,
      kind: signed ? 'signed' : 'server',
    });

    const baseColumns = [
      'chat_id',
      'message_id',
      'sender_id',
      'content',
      'created_at',
      'type',
      'attachments',
      'via_assistant',
      'chat_seq',
      'chain_hash',
      'message_hash',
    ];

    const baseParams: unknown[] = [
      dto.chatId,
      messageId,
      senderId,
      dto.content ?? null,
      createdAt,
      type,
      dto.attachments?.map((a) => ({
        media_id: a.mediaId,
        url: a.url,
        type: a.type,
        file_name: a.fileName ?? null,
        size_bytes: a.sizeBytes ?? null,
        placeholder: a.placeholder ?? null,
      })) ?? null,
      viaAssistant,
      types.Long.fromNumber(chatSeq),
      chainHash,
      messageHash,
    ];

    const columns = signed
      ? [...baseColumns, 'sender_device_id', 'seq', 'prev_hash', 'signature']
      : baseColumns;
    const params = signed
      ? [
          ...baseParams,
          signed.senderDeviceId,
          types.Long.fromNumber(signed.seq),
          signed.prevHash,
          signed.signature,
        ]
      : baseParams;

    const result = await this.cassandra.client.execute(
      `INSERT INTO messages (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})${signed ? ' IF NOT EXISTS' : ''}`,
      params,
      {
        prepare: true,
        ...(signed
          ? { serialConsistency: types.consistencies.localSerial }
          : {}),
      },
    );

    if (signed && !result.wasApplied()) {
      const stored = await this.findStoredMessage(dto.chatId, messageId);
      return {
        chatId: dto.chatId,
        messageId: messageId.toString(),
        senderId,
        content: dto.content,
        type,
        attachments: dto.attachments,
        createdAt,
        chatSeq: stored?.chatSeq ?? chatSeq,
        chainHash: stored?.chainHash ?? chainHash,
        replayed: true,
      };
    }

    const recipientIds = await this.chatsService.getMemberIds(dto.chatId);

    this.rabbitClient.emit('message.sent', {
      chatId: dto.chatId,
      messageId: messageId.toString(),
      senderId,
      content: dto.content,
      attachments: dto.attachments,
      type,
      createdAt,
      recipientIds,
      viaAssistant,
      chatSeq,
      chainHash,
    });

    this.notificationClient.emit('message.sent', {
      chatId: dto.chatId,
      senderId,
      content: dto.content,
      recipientIds,
    });

    this.assistantClient.emit('message.sent', {
      chatId: dto.chatId,
      messageId: messageId.toString(),
      senderId,
      content: dto.content,
      recipientIds,
      viaAssistant,
    });

    return {
      chatId: dto.chatId,
      messageId: messageId.toString(),
      senderId,
      content: dto.content,
      type,
      attachments: dto.attachments,
      createdAt,
      chatSeq,
      chainHash,
      replayed: false,
    };
  }

  private async findStoredMessage(
    chatId: string,
    messageId: types.TimeUuid,
  ): Promise<{ chatSeq: number | null; chainHash: string | null } | null> {
    const result = await this.cassandra.client.execute(
      `SELECT chat_seq, chain_hash FROM messages WHERE chat_id = ? AND message_id = ?`,
      [chatId, messageId],
      { prepare: true, consistency: types.consistencies.localSerial },
    );
    if (result.rowLength === 0) {
      return null;
    }

    const row = result.first();
    const chatSeq = row.get('chat_seq') as types.Long | null;
    return {
      chatSeq: chatSeq ? chatSeq.toNumber() : null,
      chainHash: (row.get('chain_hash') as string | null) ?? null,
    };
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
          url: isAvailable ? (lookup?.url ?? null) : null,
          isAvailable,
        };
      }),
    }));
  }
}
