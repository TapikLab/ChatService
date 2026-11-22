import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import type {
  ChatAdmissionCommand,
  ChatAdmissionReceipt,
  ChatAdmissionResult,
  ChatAdmissionSnapshot,
  ChatMember,
  ChatRevisionFence,
} from './chat-admission.contract';
import {
  ACCEPT_CHAT_COMMAND,
  INITIALIZE_CHAT_ADMISSION,
  READ_CHAT_ADMISSION_RECEIPT,
  READ_CHAT_ADMISSION_STATE,
  FENCE_CHAT_REVISION,
} from './chat-admission.queries';
import {
  admissionLong,
  admissionNumber,
  admissionUuid,
  assertAdmissionCommand,
  assertAdmissionKey,
  canonicalMembers,
} from './chat-admission.validation';

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
export class ChatAdmissionRepository {
  constructor(private readonly cassandra: CassandraService) {}

  async initialize(
    chatId: string,
    members: readonly ChatMember[],
  ): Promise<{ created: boolean }> {
    admissionUuid(chatId);
    const membersJson = JSON.stringify(canonicalMembers(members));
    try {
      const result = await this.cassandra.client.execute(
        INITIALIZE_CHAT_ADMISSION,
        [
          chatId,
          types.Long.fromNumber(0),
          types.Long.fromNumber(1),
          membersJson,
        ],
        CAS_WRITE,
      );

      return { created: result.wasApplied() };
    } catch {
      throw new ServiceUnavailableException(
        'CHAT_ADMISSION_INITIALIZATION_UNKNOWN',
      );
    }
  }

  async readState(chatId: string): Promise<ChatAdmissionSnapshot | null> {
    admissionUuid(chatId);
    try {
      const result = await this.cassandra.client.execute(
        READ_CHAT_ADMISSION_STATE,
        [chatId],
        SERIAL_READ,
      );

      const row = result.first();
      if (!row) return null;

      const revision = admissionLong(row.get('revision'), 0);
      const membershipVersion = admissionLong(row.get('membership_version'), 1);
      const storedMembers: unknown = row.get('members_json');
      if (
        typeof storedMembers !== 'string' ||
        storedMembers.length > 16 * 1024 ||
        membershipVersion - 1 > revision
      ) {
        throw new Error('INVALID_STATE');
      }

      const parsed: unknown = JSON.parse(storedMembers);
      const members = canonicalMembers(parsed);
      if (JSON.stringify(members) !== storedMembers) {
        throw new Error('NON_CANONICAL_MEMBERS');
      }

      return Object.freeze({
        chatId,
        revision,
        membershipVersion,
        members,
      });
    } catch {
      throw new ServiceUnavailableException('CHAT_ADMISSION_STATE_UNAVAILABLE');
    }
  }

  async readReceipt(
    chatId: string,
    entryKey: string,
  ): Promise<ChatAdmissionReceipt | null> {
    admissionUuid(chatId);
    assertAdmissionKey(entryKey);
    try {
      const result = await this.cassandra.client.execute(
        READ_CHAT_ADMISSION_RECEIPT,
        [chatId, entryKey],
        SERIAL_READ,
      );

      const row = result.first();
      if (!row) return null;

      const kind: unknown = row.get('command_kind');
      if (
        kind !== 'SEND' &&
        kind !== 'ADD_MEMBERS' &&
        kind !== 'REMOVE_MEMBER'
      ) {
        throw new Error('INVALID_COMMAND_KIND');
      }

      const receipt: ChatAdmissionReceipt = {
        chatId,
        entryKey,
        revision: admissionLong(row.get('revision'), 1),
        membershipVersion: admissionLong(row.get('membership_version'), 1),
        commandKind: kind,
        actorId: admissionUuid(String(row.get('actor_id'))),
        requestHash: String(row.get('request_hash')),
        operationRef: String(row.get('operation_ref')),
      };

      assertAdmissionCommand(receipt);

      if (receipt.membershipVersion - 1 > receipt.revision) {
        throw new Error('INVALID_RECEIPT_VERSION');
      }

      return Object.freeze(receipt);
    } catch {
      throw new ServiceUnavailableException(
        'CHAT_ADMISSION_RECEIPT_UNAVAILABLE',
      );
    }
  }

  async tryAccept(
    expected: ChatAdmissionSnapshot,
    command: ChatAdmissionCommand,
    nextMembers: readonly ChatMember[],
  ): Promise<ChatAdmissionResult> {
    admissionUuid(expected.chatId);
    admissionNumber(expected.revision, 0);
    admissionNumber(expected.membershipVersion, 1);
    assertAdmissionCommand(command);

    if (expected.membershipVersion - 1 > expected.revision) {
      throw new ConflictException('INVALID_MEMBERSHIP_VERSION');
    }

    const currentJson = JSON.stringify(canonicalMembers(expected.members));
    const nextJson = JSON.stringify(canonicalMembers(nextMembers));
    const existing = await this.readReceipt(expected.chatId, command.entryKey);
    if (existing) return this.accepted(existing, command);

    const changesMembership = command.commandKind !== 'SEND';
    if (
      (!changesMembership && nextJson !== currentJson) ||
      (changesMembership && nextJson === currentJson)
    ) {
      throw new ConflictException('COMMAND_MEMBERSHIP_CHANGE_MISMATCH');
    }

    if (
      expected.revision === Number.MAX_SAFE_INTEGER ||
      (changesMembership &&
        expected.membershipVersion === Number.MAX_SAFE_INTEGER)
    ) {
      throw new ConflictException('CHAT_VERSION_EXHAUSTED');
    }

    const revision = expected.revision + 1;
    const membershipVersion =
      expected.membershipVersion + Number(changesMembership);
    let applied: boolean;
    try {
      const result = await this.cassandra.client.execute(
        ACCEPT_CHAT_COMMAND,
        [
          types.Long.fromNumber(revision),
          types.Long.fromNumber(membershipVersion),
          nextJson,
          expected.chatId,
          types.Long.fromNumber(expected.revision),
          types.Long.fromNumber(expected.membershipVersion),
          currentJson,

          expected.chatId,
          command.entryKey,
          types.Long.fromNumber(revision),
          types.Long.fromNumber(membershipVersion),
          command.commandKind,
          command.actorId,
          command.requestHash,
          command.operationRef,
        ],
        CAS_WRITE,
      );

      applied = result.wasApplied();
    } catch {
      const receipt = await this.readReceipt(
        expected.chatId,
        command.entryKey,
      ).catch(() => null);
      if (receipt) return this.accepted(receipt, command);

      throw new ServiceUnavailableException('CHAT_ADMISSION_OUTCOME_UNKNOWN');
    }

    if (applied) {
      return this.accepted(
        Object.freeze({
          chatId: expected.chatId,
          entryKey: command.entryKey,
          revision,
          membershipVersion,
          commandKind: command.commandKind,
          actorId: command.actorId,
          requestHash: command.requestHash,
          operationRef: command.operationRef,
        }),
        command,
      );
    }

    const receipt = await this.readReceipt(expected.chatId, command.entryKey);
    if (receipt) return this.accepted(receipt, command);

    return { status: 'stale' };
  }

  private accepted(
    receipt: ChatAdmissionReceipt,
    command: ChatAdmissionCommand,
  ): ChatAdmissionResult {
    if (
      receipt.entryKey !== command.entryKey ||
      receipt.commandKind !== command.commandKind ||
      receipt.actorId !== command.actorId ||
      receipt.requestHash !== command.requestHash ||
      receipt.operationRef !== command.operationRef
    ) {
      throw new ConflictException('CHAT_COMMAND_ID_REUSED');
    }

    return {
      status: 'accepted',
      receipt,
    };
  }

  async fenceRevision(
    chatId: string,
    expectedRevision: number,
  ): Promise<ChatRevisionFence> {
    admissionUuid(chatId);
    admissionNumber(expectedRevision, 0);

    const before = await this.readState(chatId);
    if (!before) {
      throw new ServiceUnavailableException('CHAT_ADMISSION_NOT_INITIALIZED');
    }

    if (before.revision < expectedRevision) {
      throw new ServiceUnavailableException('CHAT_REVISION_BEHIND_ATTEMPT');
    }

    if (before.revision > expectedRevision) {
      return Object.freeze({
        chatId,
        closedRevision: expectedRevision,
        observedRevision: before.revision,
      });
    }

    if (expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new ServiceUnavailableException('CHAT_REVISION_EXHAUSTED');
    }

    try {
      const result = await this.cassandra.client.execute(
        FENCE_CHAT_REVISION,
        [
          types.Long.fromNumber(expectedRevision + 1),
          chatId,
          types.Long.fromNumber(expectedRevision),
        ],
        CAS_WRITE,
      );

      if (result.wasApplied()) {
        return Object.freeze({
          chatId,
          closedRevision: expectedRevision,
          observedRevision: expectedRevision + 1,
        });
      }
    } catch {}

    const after = await this.readState(chatId);
    if (!after || after.revision <= expectedRevision) {
      throw new ServiceUnavailableException('CHAT_REVISION_FENCE_UNCONFIRMED');
    }

    return Object.freeze({
      chatId,
      closedRevision: expectedRevision,
      observedRevision: after.revision,
    });
  }
}
