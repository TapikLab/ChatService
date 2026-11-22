import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import type {
  ChatAdmissionReceipt,
  ChatMember,
} from '@modules/message-writer/admission/chat-admission.contract';
import { prepareMembershipCommand } from '@modules/chat-membership/chat-membership-command';
import type { PreparedMembershipCommand } from '@modules/chat-membership/chat-membership-command';
import { WriterDeviceKeysService } from '@modules/message-writer/writer-device-keys.service';
import { admissionUuid } from '@modules/message-writer/admission/chat-admission.validation';

export interface ChatMembershipView {
  readonly chatId: string;
  readonly membershipVersion: number;
  readonly members: readonly ChatMember[];
}

export interface MembershipCommandReply {
  readonly chatId: string;
  readonly requestId: string;
  readonly kind: 'ADD_MEMBERS' | 'REMOVE_MEMBER';
  readonly membershipVersion: number;
}

const MAX_MEMBERS = 64;

const READ_OPTIONS = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
};

const INDEX_WRITE_OPTIONS = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  serialConsistency: types.consistencies.localSerial,
  isIdempotent: false,
};

@Injectable()
export class ChatMembershipAdmissionService {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly admission: ChatAdmissionRepository,
    private readonly keys: WriterDeviceKeysService,
  ) {}

  async changeMembers(
    actorId: string,
    body: unknown,
  ): Promise<MembershipCommandReply> {
    const receipt = await this.change(actorId, body);
    if (
      receipt.commandKind !== 'ADD_MEMBERS' &&
      receipt.commandKind !== 'REMOVE_MEMBER'
    ) {
      throw new ServiceUnavailableException('INVALID_MEMBERSHIP_RECEIPT_KIND');
    }

    return Object.freeze({
      chatId: receipt.chatId,
      requestId: receipt.entryKey.slice('membership:'.length),
      kind: receipt.commandKind,
      membershipVersion: receipt.membershipVersion,
    });
  }

  private async change(
    actorId: string,
    body: unknown,
  ): Promise<ChatAdmissionReceipt> {
    const command = prepareMembershipCommand(actorId, body);
    const existing = await this.admission.readReceipt(
      command.chatId,
      command.entryKey,
    );
    if (existing) {
      this.assertSameCommand(existing, command);
      return existing;
    }

    const snaphot = await this.admission.readState(command.chatId);
    if (!snaphot) {
      throw new ServiceUnavailableException('CHAT_ADMISSION_NOT_INITIALIZED');
    }

    const actor = snaphot.members.find((member) => member.userId === actorId);
    if (!actor || actor.role !== 'admin') {
      throw new ForbiddenException('CHAT_ADMIN_REQUIRED');
    }

    if (snaphot.membershipVersion !== command.expectedMembershipVersion) {
      throw new ConflictException('CHAT_MEMBERSHIP_VERSION_CHANGED');
    }

    await this.assertGroup(command.chatId);

    const currentIds = new Set(snaphot.members.map((member) => member.userId));
    let nextMembers: readonly ChatMember[];
    if (command.kind === 'ADD_MEMBERS') {
      if (command.userIds.some((userId) => currentIds.has(userId))) {
        throw new ConflictException('CHAT_MEMBER_ALREADY_EXISTS');
      }

      if (snaphot.members.length + command.userIds.length > MAX_MEMBERS) {
        throw new ConflictException('CHAT_MEMBER_LIMIT_EXCEEDED');
      }

      await this.keys.getRosters(command.userIds);

      nextMembers = [
        ...snaphot.members,
        ...command.userIds.map((userId): ChatMember => ({
          userId,
          role: 'member',
        })),
      ];
    } else {
      const targetUserId = command.userIds[0];
      if (targetUserId === actorId) {
        throw new BadRequestException('SELF_REMOVAL_REQUIRES_LEAVE_COMMAND');
      }

      if (!currentIds.has(targetUserId)) {
        throw new NotFoundException('CHAT_MEMBER_NOT_FOUND');
      }

      nextMembers = snaphot.members.filter(
        (member) => member.userId !== targetUserId,
      );
    }

    if (command.kind === 'ADD_MEMBERS') {
      await this.ensureUserIndexes(command.chatId, command.userIds);
    }

    const result = await this.admission.tryAccept(
      snaphot,
      {
        entryKey: command.entryKey,
        commandKind: command.kind,
        actorId: command.actorId,
        requestHash: command.requestHash,
        operationRef: command.entryKey,
      },
      nextMembers,
    );

    if (result.status === 'stale') {
      throw new ServiceUnavailableException(
        'CHAT_STATE_CHANGED_RETRY_SAME_REQUEST',
      );
    }

    return result.receipt;
  }

  private assertSameCommand(
    receipt: ChatAdmissionReceipt,
    command: PreparedMembershipCommand,
  ): void {
    if (
      receipt.chatId !== command.chatId ||
      receipt.entryKey !== command.entryKey ||
      receipt.commandKind !== command.kind ||
      receipt.actorId !== command.actorId ||
      receipt.requestHash !== command.requestHash ||
      receipt.operationRef !== command.entryKey
    ) {
      throw new ConflictException('MEMBERSHIP_REQUEST_ID_REUSED');
    }
  }

  private async assertGroup(chatId: string): Promise<void> {
    let row: types.Row | null;
    try {
      const result = await this.cassandra.client.execute(
        `
          SELECT type
          FROM chats
          WHERE chat_id = ?
        `,
        [chatId],
        READ_OPTIONS,
      );

      row = result.first() ?? null;
    } catch {
      throw new ServiceUnavailableException('CHAT_METADATA_UNAVAILABLE');
    }

    if (!row) {
      throw new NotFoundException('CHAT_NOT_FOUND');
    }

    const chatType: unknown = row.get('type');
    if (chatType === 'direct') {
      throw new BadRequestException('GROUP_CHAT_REQUIRED');
    }

    if (chatType !== 'group') {
      throw new ServiceUnavailableException('INVALID_CHAT_TYPE');
    }
  }

  private async ensureUserIndexes(
    chatId: string,
    userIds: readonly string[],
  ): Promise<void> {
    const indexedAt = new Date();
    for (let offset = 0; offset < userIds.length; offset += 4) {
      const result = await Promise.allSettled(
        userIds.slice(offset, offset + 4).map((userId) =>
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
            [userId, chatId, indexedAt],
            INDEX_WRITE_OPTIONS,
          ),
        ),
      );

      if (result.some((result) => result.status === 'rejected')) {
        throw new ServiceUnavailableException(
          'MEMBERSHIP_INDEX_WRITE_UNCONFIRMED',
        );
      }
    }
  }
}
