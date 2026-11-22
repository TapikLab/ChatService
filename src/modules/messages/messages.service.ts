import { Injectable, Inject, GoneException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { types } from 'cassandra-driver';
import { SendMessageDto } from './dto/send-message.dto';
import { WriterTransportService } from '@modules/message-writer/legacy/writer-transport.service';
import { type SignedProof } from '@modules/message-writer/legacy/contract';

import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatsService } from '@modules/chats/chats.service';
import { MediaClientService } from '@modules/media-client/media-client.service';
import type { StoredMessage } from '@modules/message-writer/legacy/contract';

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
    @Inject('RABBITMQ_SERVICE')
    private readonly rabbitClient: ClientProxy,
    @Inject('NOTIFICATION_SERVICE')
    private readonly notificationClient: ClientProxy,
  ) {}

  async sendMessage(
    senderId: string,
    dto: SendMessageDto,
    viaAssistant = false,
    signed?: SignedMessageMeta,
  ): Promise<StoredMessage> {
    void senderId;
    void dto;
    void viaAssistant;
    void signed;

    throw new GoneException('E2EE_REQUIRED');
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
}
