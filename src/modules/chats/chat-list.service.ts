import {
  BadRequestException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatAccessService } from '@modules/chat-access/chat-access.service';
import type {
  ChatAdmissionSnapshot,
  ChatMemberRole,
} from '@modules/message-writer/admission/chat-admission.contract';
import { admissionUuid } from '@modules/message-writer/admission/chat-admission.validation';

export interface ChatListItem {
  readonly chatId: string;
  readonly type: 'direct' | 'group';
  readonly title: string | null;
  readonly createdAt: string;
  readonly role: ChatMemberRole;
  readonly membershipVersion: number;
  readonly otherMemberId: string | null;
}

export interface ChatListPage {
  readonly items: readonly ChatListItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

interface AccessibleChat {
  readonly chatId: string;
  readonly role: ChatMemberRole;
  readonly snapshot: ChatAdmissionSnapshot;
}

const PAGE_SIZE = 20;
const ACCESS_CONCURRENCY = 4;

const READ_OPTIONS = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  isIdempotent: true,
};

function invalidRecord(): never {
  throw new ServiceUnavailableException('INVALID_CHAT_LIST_RECORD');
}

function readCursor(query: unknown): string | undefined {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new BadRequestException('INVALID_CHAT_LIST_QUERY');
  }

  const input = query as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'cursor')) {
    throw new BadRequestException('INVALID_CHAT_LIST_QUERY');
  }
  if (input.cursor === undefined) return undefined;

  return admissionUuid(input.cursor);
}

@Injectable()
export class ChatListService implements OnModuleInit {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly access: ChatAccessService,
  ) {}

  async onModuleInit(): Promise<void> {
    const result = await this.cassandra.client.execute(
      `
        SELECT column_name, kind, position, type
        FROM system_schema.columns
        WHERE keyspace_name = ?
          AND table_name = ?
      `,
      [this.cassandra.client.keyspace, 'user_chats'],
      { prepare: true },
    );

    const partitionKeys = result.rows.filter(
      (row) => row.get('kind') === 'partition_key',
    );
    const clusteringKeys = result.rows.filter(
      (row) => row.get('kind') === 'clustering',
    );

    const partition = partitionKeys[0];
    const clustering = clusteringKeys[0];
    if (
      partitionKeys.length !== 1 ||
      clusteringKeys.length !== 1 ||
      partition?.get('column_name') !== 'user_id' ||
      partition.get('type') !== 'uuid' ||
      clustering?.get('column_name') !== 'chat_id' ||
      clustering.get('type') !== 'uuid' ||
      clustering.get('position') !== 0
    ) {
      throw new Error('USER_CHATS_PAGINATION_SCHEMA_REQUIRED');
    }
  }

  async getPage(userId: string, query: unknown = {}): Promise<ChatListPage> {
    admissionUuid(userId);
    const cursor = readCursor(query);
    const statement = cursor
      ? `
          SELECT chat_id
          FROM user_chats
          WHERE user_id = ?
            AND chat_id > ?
          ORDER BY chat_id ASC
          LIMIT ?
        `
      : `
          SELECT chat_id
          FROM user_chats
          WHERE user_id = ?
          ORDER BY chat_id ASC
          LIMIT ?
        `;

    const parameters: unknown[] = cursor
      ? [userId, cursor, PAGE_SIZE + 1]
      : [userId, PAGE_SIZE + 1];

    let rows: types.Row[];
    try {
      const result = await this.cassandra.client.execute(
        statement,
        parameters,
        { ...READ_OPTIONS, fetchSize: PAGE_SIZE + 1 },
      );

      rows = result.rows;
    } catch {
      throw new ServiceUnavailableException('CHAT_LIST_INDEX_UNAVAILABLE');
    }

    const selectedRows = rows.slice(0, PAGE_SIZE);
    const chatIds = selectedRows.map((row): string => {
      const value: unknown = row.get('chat_id');
      if (!(value instanceof types.Uuid)) return invalidRecord();

      return value.toString();
    });

    const accessible: AccessibleChat[] = [];
    for (
      let offset = 0;
      offset < chatIds.length;
      offset += ACCESS_CONCURRENCY
    ) {
      const batch = chatIds.slice(offset, offset + ACCESS_CONCURRENCY);
      const checked = await Promise.all(
        batch.map(async (chatId): Promise<AccessibleChat | null> => {
          const snapshot = await this.access.getSnapshot(chatId);
          const member = snapshot.members.find(
            (item) => item.userId === userId,
          );
          if (!member) return null;

          return { chatId, role: member.role, snapshot };
        }),
      );

      for (const chat of checked) {
        if (chat) accessible.push(chat);
      }
    }

    const items = await this.readItems(userId, accessible);
    const hasMore = rows.length > PAGE_SIZE;
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor: hasMore ? chatIds[chatIds.length - 1]! : null,
      hasMore,
    });
  }

  private async readItems(
    userId: string,
    accessible: readonly AccessibleChat[],
  ): Promise<ChatListItem[]> {
    if (accessible.length === 0) return [];

    let rows: types.Row[];
    try {
      const result = await this.cassandra.client.execute(
        `
          SELECT chat_id, type, title, created_at
          FROM chats
          WHERE chat_id IN ?
        `,
        [accessible.map((chat) => types.Uuid.fromString(chat.chatId))],
        { ...READ_OPTIONS, fetchSize: PAGE_SIZE },
      );

      rows = result.rows;
    } catch {
      throw new ServiceUnavailableException('CHAT_LIST_METADATA_UNAVAILABLE');
    }

    const byId = new Map<string, types.Row>();
    for (const row of rows) {
      const chatId: unknown = row.get('chat_id');
      if (!(chatId instanceof types.Uuid)) return invalidRecord();

      const key = chatId.toString();
      if (byId.has(key)) return invalidRecord();

      byId.set(key, row);
    }

    return accessible.map((chat): ChatListItem => {
      const row = byId.get(chat.chatId);
      if (!row) return invalidRecord();

      const type: unknown = row.get('type');
      const title: unknown = row.get('title');
      const createdAt: unknown = row.get('created_at');
      if (
        (type !== 'direct' && type !== 'group') ||
        !(createdAt instanceof Date) ||
        !Number.isFinite(createdAt.getTime())
      )
        return invalidRecord();

      let normalizedTitle: string | null;
      let otherMemberId: string | null = null;
      if (type === 'direct') {
        if (title != null || chat.snapshot.members.length !== 2)
          return invalidRecord();

        const other = chat.snapshot.members.find(
          (member) => member.userId !== userId,
        );
        if (!other) return invalidRecord();

        normalizedTitle = null;
        otherMemberId = other.userId;
      } else {
        if (
          typeof title !== 'string' ||
          title.length === 0 ||
          title.length > 100
        )
          return invalidRecord();

        normalizedTitle = title;
      }

      return Object.freeze({
        chatId: chat.chatId,
        type,
        title: normalizedTitle,
        createdAt: createdAt.toISOString(),
        role: chat.role,
        membershipVersion: chat.snapshot.membershipVersion,
        otherMemberId,
      });
    });
  }
}
