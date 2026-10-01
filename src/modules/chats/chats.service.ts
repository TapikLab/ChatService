import {
  Injectable,
  Inject,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { CreateChatDto } from './dto/create-chat.dto';

@Injectable()
export class ChatsService {
  constructor(
    private readonly cassandra: CassandraService,
    @Inject('RABBITMQ_SERVICE') private readonly rabbitClient: ClientProxy,
    @Inject('REACTIONS_SERVICE')
    private readonly reactionsClient: ClientProxy,
  ) {}

  async createChat(creatorId: string, dto: CreateChatDto) {
    if (dto.type === 'direct' && dto.memberIds.length !== 1) {
      throw new BadRequestException(
        'Личный чат должен содержать ровно одного собеседника',
      );
    }

    const chatId = types.Uuid.random();
    const createdAt = new Date();
    const otherMemberIds = [...new Set(dto.memberIds)].filter(
      (id) => id !== creatorId,
    );

    await this.cassandra.client.execute(
      `INSERT INTO chats (chat_id, type, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      [chatId, dto.type, dto.title ?? null, creatorId, createdAt],
      { prepare: true },
    );

    const memberEntries = [
      { userId: creatorId, role: 'admin' },
      ...otherMemberIds.map((userId) => ({ userId, role: 'member' })),
    ];

    const queries = memberEntries.flatMap(({ userId, role }) => [
      {
        query: `INSERT INTO chat_members (chat_id, user_id, joined_at, role) VALUES (?, ?, ?, ?)`,
        params: [chatId, userId, createdAt, role],
      },
      {
        query: `INSERT INTO user_chats (user_id, chat_id, joined_at) VALUES (?, ?, ?)`,
        params: [userId, chatId, createdAt],
      },
    ]);

    await this.cassandra.client.batch(queries, { prepare: true });

    return {
      chatId: chatId.toString(),
      creatorId,
      type: dto.type,
      title: dto.title,
      members: memberEntries,
    };
  }

  async getUserChats(userId: string) {
    const result = await this.cassandra.client.execute(
      `SELECT * FROM user_chats WHERE user_id = ?`,
      [userId],
      { prepare: true },
    );

    return result.rows;
  }

  async isMember(chatId: string, userId: string): Promise<boolean> {
    const result = await this.cassandra.client.execute(
      `SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id = ?`,
      [chatId, userId],
      { prepare: true },
    );
    return result.rowLength > 0;
  }

  async assertMember(chatId: string, userId: string) {
    const member = await this.isMember(chatId, userId);
    if (!member) {
      throw new ForbiddenException('Вы не состоите в этом чате');
    }
  }

  async getMemberRole(chatId: string, userId: string): Promise<string | null> {
    const result = await this.cassandra.client.execute(
      `SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`,
      [chatId, userId],
      { prepare: true },
    );
    if (result.rowLength === 0) {
      return null;
    }
    return result.first().get('role') as string;
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

  async addMembers(
    chatId: string,
    requesterId: string,
    newMemberIds: string[],
  ) {
    const chat = await this.getChat(chatId);
    if (chat.type !== 'group') {
      throw new BadRequestException(
        'Добавлять участников можно только в групповой чат',
      );
    }

    await this.assertAdmin(chatId, requesterId);

    const uniqueIds = [...new Set(newMemberIds)].filter(
      (id) => id !== requesterId,
    );

    if (uniqueIds.length === 0) {
      throw new BadRequestException('Нет новых участников для добавления');
    }

    const alreadyMembersFlags = await Promise.all(
      uniqueIds.map((id) => this.isMember(chatId, id)),
    );
    const idsToAdd = uniqueIds.filter(
      (_, index) => !alreadyMembersFlags[index],
    );

    if (idsToAdd.length === 0) {
      throw new ConflictException(
        'Все указанные пользователи уже состоят в чате',
      );
    }

    const joinedAt = new Date();

    const queries = idsToAdd.flatMap((userId) => [
      {
        query: `INSERT INTO chat_members (chat_id, user_id, joined_at, role) VALUES (?, ?, ?, ?)`,
        params: [chatId, userId, joinedAt, 'member'],
      },
      {
        query: `INSERT INTO user_chats (user_id, chat_id, joined_at) VALUES (?, ?, ?)`,
        params: [userId, chatId, joinedAt],
      },
    ]);

    await this.cassandra.client.batch(queries, { prepare: true });

    this.reactionsClient.emit('chat.members.changed', { chatId });

    return { chatId, addedMemberIds: idsToAdd };
  }

  async removeMember(
    chatId: string,
    requesterId: string,
    targetUserId: string,
  ) {
    await this.assertAdmin(chatId, requesterId);

    if (requesterId === targetUserId) {
      throw new BadRequestException(
        'Нельзя удалить самого себя таким способом — используйте выход из группы',
      );
    }

    const targetIsMember = await this.isMember(chatId, targetUserId);
    if (!targetIsMember) {
      throw new NotFoundException('Этот пользователь не состоит в чате');
    }

    await this.cassandra.client.batch(
      [
        {
          query: `DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?`,
          params: [chatId, targetUserId],
        },
        {
          query: `DELETE FROM user_chats WHERE user_id = ? AND chat_id = ?`,
          params: [targetUserId, chatId],
        },
      ],
      { prepare: true },
    );

    this.reactionsClient.emit('chat.members.changed', { chatId });

    return { chatId, removedUserId: targetUserId };
  }

  async getMemberIds(chatId: string): Promise<string[]> {
    const result = await this.cassandra.client.execute(
      `SELECT user_id FROM chat_members WHERE chat_id = ?`,
      [chatId],
      { prepare: true },
    );
    return result.rows.map((row) => String(row.get('user_id')));
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

  async getUnreadMessages(userId: string, maxMessagesPerChat = 20) {
    const userChats = await this.getUserChats(userId);

    const chats = await Promise.all(
      userChats.map(async (row) => {
        const chatId = String(row.get('chat_id'));

        const [chat, readState] = await Promise.all([
          this.getChat(chatId),
          this.getReadState(userId, chatId),
        ]);

        const lastReadMessageId =
          readState?.get('last_read_message_id') ?? null;

        const query = lastReadMessageId
          ? `SELECT message_id, sender_id, content, type, created_at FROM messages WHERE chat_id = ? AND message_id > ? LIMIT ?`
          : `SELECT message_id, sender_id, content, type, created_at FROM messages WHERE chat_id = ? LIMIT ?`;
        const params = lastReadMessageId
          ? [chatId, lastReadMessageId, maxMessagesPerChat]
          : [chatId, maxMessagesPerChat];

        const result = await this.cassandra.client.execute(query, params, {
          prepare: true,
        });

        const unread = result.rows.filter(
          (r) => String(r.get('sender_id')) !== userId,
        );

        if (unread.length === 0) {
          return null;
        }

        let otherMemberId = '';
        if (chat.get('type') === 'direct') {
          const memberIds = await this.getMemberIds(chatId);
          otherMemberId = memberIds.find((id) => id !== userId) ?? '';
        }

        return {
          chatId,
          chatType: chat.get('type') as string,
          title: (chat.get('title') as string) ?? '',
          otherMemberId,
          messages: unread.map((r) => ({
            messageId: r.get('message_id').toString(),
            senderId: String(r.get('sender_id')),
            content: (r.get('content') as string) ?? '',
            type: r.get('type') as string,
            createdAt: (r.get('created_at') as Date).toISOString(),
          })),
        };
      }),
    );

    return chats.filter((c): c is NonNullable<typeof c> => c !== null);
  }

  async getDirectChats(userId: string) {
    const userChats = await this.getUserChats(userId);

    const chats = await Promise.all(
      userChats.map(async (row) => {
        const chatId = String(row.get('chat_id'));
        const chat = await this.getChat(chatId);
        if (chat.get('type') !== 'direct') return null;

        const memberIds = await this.getMemberIds(chatId);
        const otherMemberId = memberIds.find((id) => id !== userId) ?? '';
        if (!otherMemberId) return null;

        return { chatId, otherMemberId };
      }),
    );

    return chats.filter((c): c is NonNullable<typeof c> => c !== null);
  }

  async getUserMessagesInChat(chatId: string, userId: string, limit = 15) {
    const result = await this.cassandra.client.execute(
      `SELECT content, sender_id, via_assistant FROM messages WHERE chat_id = ? LIMIT ?`,
      [chatId, limit * 4],
      { prepare: true },
    );

    return result.rows
      .filter(
        (r) =>
          String(r.get('sender_id')) === userId &&
          r.get('content') &&
          !r.get('via_assistant'),
      )
      .slice(0, limit)
      .map((r) => r.get('content') as string);
  }

  async getRecentMessages(chatId: string, limit = 10) {
    const result = await this.cassandra.client.execute(
      `SELECT sender_id, content, via_assistant, created_at FROM messages WHERE chat_id = ? LIMIT ?`,
      [chatId, limit],
      { prepare: true },
    );

    return result.rows
      .filter((r) => r.get('content'))
      .map((r) => ({
        senderId: String(r.get('sender_id')),
        content: r.get('content') as string,
        viaAssistant: Boolean(r.get('via_assistant')),
        createdAt: (r.get('created_at') as Date).toISOString(),
      }))
      .reverse();
  }
}
