import {
  Injectable,
  Inject,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatAccessService } from '@modules/chat-access/chat-access.service';
import { ChatListService } from './chat-list.service';

@Injectable()
export class ChatsService {
  constructor(
    private readonly cassandra: CassandraService,
    @Inject('RABBITMQ_SERVICE') private readonly rabbitClient: ClientProxy,
    private readonly access: ChatAccessService,
    private readonly chatList: ChatListService,
  ) {}

  async isMember(chatId: string, userId: string): Promise<boolean> {
    return this.access.isMember(chatId, userId);
  }

  async assertMember(chatId: string, userId: string) {
    const member = await this.isMember(chatId, userId);
    if (!member) {
      throw new ForbiddenException('Вы не состоите в этом чате');
    }
  }

  async getMemberRole(chatId: string, userId: string): Promise<string | null> {
    return this.access.getRole(chatId, userId);
  }

  async assertAdmin(chatId: string, userId: string) {
    const role = await this.getMemberRole(chatId, userId);
    if (role !== 'admin') {
      throw new ForbiddenException(
        'Только администратор группы может выполнить это действие',
      );
    }
  }

  async getChat(chatId: string) {
    const result = await this.cassandra.client.execute(
      `SELECT * FROM chats WHERE chat_id = ?`,
      [chatId],
      { prepare: true },
    );
    if (result.rowLength === 0) {
      throw new NotFoundException('Чат не найден');
    }
    return result.first();
  }

  async getMemberIds(chatId: string): Promise<string[]> {
    return this.access.getMemberIds(chatId);
  }

  async markAsRead(chatId: string, userId: string, messageId: string) {
    await this.assertMember(chatId, userId);

    await this.cassandra.client.execute(
      `INSERT INTO chat_read_state (user_id, chat_id, last_read_message_id, updated_at) VALUES (?, ?, ?, ?)`,
      [userId, chatId, messageId, new Date()],
      { prepare: true },
    );

    const recipientIds = await this.getMemberIds(chatId);
    this.rabbitClient.emit('chat.read', {
      chatId,
      userId,
      lastReadMessageId: messageId,
      recipientIds,
    });

    return { chatId, lastReadMessageId: messageId };
  }

  async getReadState(userId: string, chatId: string) {
    const result = await this.cassandra.client.execute(
      `SELECT last_read_message_id, updated_at FROM chat_read_state WHERE user_id = ? AND chat_id = ?`,
      [userId, chatId],
      { prepare: true },
    );

    return result.rowLength ? result.first() : null;
  }

  async getDirectChats(
    userId: string,
  ): Promise<Array<{ chatId: string; otherMemberId: string }>> {
    const chats: Array<{
      chatId: string;
      otherMemberId: string;
    }> = [];

    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page = await this.chatList.getPage(
        userId,
        cursor === undefined ? {} : { cursor },
      );

      for (const chat of page.items) {
        if (chat.type === 'direct' && chat.otherMemberId !== null) {
          chats.push({
            chatId: chat.chatId,
            otherMemberId: chat.otherMemberId,
          });
        }
      }

      if (page.nextCursor === null) return chats;

      cursor = page.nextCursor;
    }

    throw new ServiceUnavailableException(
      'DIRECT_CHAT_LIST_REQUIRES_PAGINATION',
    );
  }
}
