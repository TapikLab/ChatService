import {
  ConflictException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import { prepareCreateChat } from '@modules/chats/create-chat-command';

export interface CreatedChat {
  readonly chatId: string;
  readonly creatorId: string;
  readonly type: 'direct' | 'group';
  readonly title: string | null;
  readonly createdAt: string;
}

const SERIAL_READ = {
  prepare: true,
  consistency: types.consistencies.localSerial,
};

const CAS_WRITE = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  serialConsistency: types.consistencies.localSerial,
  isIdempotent: false,
};

@Injectable()
export class CreateChatService implements OnModuleInit {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly admission: ChatAdmissionRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const table of ['chats', 'user_chats']) {
      const result = await this.cassandra.client.execute(
        `
          SELECT default_time_to_live
          FROM system_schema.tables
          WHERE keyspace_name = ?
            AND table_name = ?
        `,
        [this.cassandra.client.keyspace, table],
        { prepare: true },
      );

      if (result.first()?.get('default_time_to_live') !== 0) {
        throw new Error(`NON_EXPIRING_TABLE_REQUIRED:${table}`);
      }
    }
  }

  async create(creatorId: string, body: unknown): Promise<CreatedChat> {
    const command = prepareCreateChat(creatorId, body);
    try {
      await this.cassandra.client.execute(
        `
          INSERT INTO chats (
            chat_id,
            type,
            title,
            created_by,
            created_at,
            creation_hash
          )
          VALUES (?, ?, ?, ?, ?, ?)
          IF NOT EXISTS
        `,
        [
          command.chatId,
          command.type,
          command.title,
          command.creatorId,
          new Date(),
          command.requestHash,
        ],
        CAS_WRITE,
      );
    } catch {
      // The write may have succeeded before its response was lost.
      // Confirm the stored result using a serial read below.
    }

    let row: types.Row | null;
    try {
      const result = await this.cassandra.client.execute(
        `
          SELECT
            type,
            title,
            created_by,
            created_at,
            creation_hash
          FROM chats
          WHERE chat_id = ?
        `,
        [command.chatId],
        SERIAL_READ,
      );

      row = result.first() ?? null;
    } catch {
      throw new ServiceUnavailableException('CHAT_CREATION_OUTCOME_UNKNOWN');
    }

    if (!row) {
      throw new ServiceUnavailableException('CHAT_CREATION_OUTCOME_UNKNOWN');
    }

    const storedTitle: unknown = row.get('title');
    if (
      String(row.get('created_by')) !== command.creatorId ||
      row.get('creation_hash') !== command.requestHash ||
      row.get('type') !== command.type ||
      (storedTitle ?? null) !== command.title
    ) {
      throw new ConflictException('CHAT_ID_REUSED');
    }

    const createdAt: unknown = row.get('created_at');
    if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
      throw new ServiceUnavailableException('INVALID_CHAT_CREATION_RECORD');
    }

    await this.admission.initialize(command.chatId, command.members);

    const snapshot = await this.admission.readState(command.chatId);
    if (!snapshot) {
      throw new ServiceUnavailableException(
        'CHAT_INITIALIZATION_NOT_CONFIRMED',
      );
    }

    for (let offset = 0; offset < command.members.length; offset += 4) {
      const result = await Promise.allSettled(
        command.members.slice(offset, offset + 4).map((member) =>
          this.cassandra.client.execute(
            `
              INSERT INTO user_chats (
                user_id,
                chat_id,
                joined_at
              )
              VALUES (?, ?, ?)
              IF NOT EXISTS
            `,
            [member.userId, command.chatId, createdAt],
            CAS_WRITE,
          ),
        ),
      );

      if (result.some((result) => result.status === 'rejected')) {
        throw new ServiceUnavailableException('CHAT_INDEX_WRITE_UNCONFIRMED');
      }
    }

    return Object.freeze({
      chatId: command.chatId,
      creatorId: command.creatorId,
      type: command.type,
      title: command.title,
      createdAt: createdAt.toISOString(),
    });
  }
}
