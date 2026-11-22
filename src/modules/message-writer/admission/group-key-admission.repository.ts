import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatAdmissionRepository } from './chat-admission.repository';
import type {
  ChatAdmissionCommand,
  ChatAdmissionReceipt,
  ChatAdmissionResult,
  ChatAdmissionSnapshot,
} from './chat-admission.contract';
import {
  admissionLong,
  admissionNumber,
  admissionUuid,
  assertAdmissionCommand,
  assertAdmissionKey,
  canonicalMembers,
} from './chat-admission.validation';

export interface GroupKeyContext {
  readonly senderDeviceId: string;
  readonly distributionId: string;
  readonly deviceSetHash: string;
}

export interface RegisteredGroupKey extends GroupKeyContext {
  readonly receipt: ChatAdmissionReceipt;
}

const HASH = /^[0-9a-f]{64}$/;

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

const ACCEPT_DISTRIBUTION = `
  BEGIN BATCH

    UPDATE e2e_chat_admission
    SET revision = ?
    WHERE chat_id = ?
      AND entry_key = 'state'
    IF revision = ?
      AND membership_version = ?
      AND members_json = ?;

    INSERT INTO e2e_chat_admission (
      chat_id,
      entry_key,
      revision,
      membership_version,
      command_kind,
      actor_id,
      request_hash,
      operation_ref
    )
    VALUES (?, ?, ?, ?, 'SEND', ?, ?, ?)
    IF NOT EXISTS;

    INSERT INTO e2e_chat_admission (
      chat_id,
      entry_key,
      revision,
      membership_version,
      command_kind,
      actor_id,
      request_hash,
      operation_ref,
      device_set_hash
    )
    VALUES (
      ?, ?, ?, ?, 'SENDER_KEY_DISTRIBUTION', ?, ?, ?, ?
    )
    IF NOT EXISTS;

  APPLY BATCH
`;

@Injectable()
export class GroupKeyAdmissionRepository {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly admission: ChatAdmissionRepository,
  ) {}

  async readRegistration(
    chatId: string,
    senderDeviceId: string,
    distributionId: string,
  ): Promise<RegisteredGroupKey | null> {
    admissionUuid(chatId);
    admissionUuid(senderDeviceId);
    admissionUuid(distributionId);

    let row: types.Row | null;
    try {
      const result = await this.cassandra.client.execute(
        `
          SELECT
            revision,
            membership_version,
            command_kind,
            actor_id,
            request_hash,
            operation_ref,
            device_set_hash
          FROM e2e_chat_admission
          WHERE chat_id = ?
            AND entry_key = ?
        `,
        [chatId, this.registrationKey(senderDeviceId, distributionId)],
        SERIAL_READ,
      );

      row = result.first() ?? null;
    } catch {
      throw new ServiceUnavailableException(
        'GROUP_KEY_REGISTRATION_UNAVAILABLE',
      );
    }

    if (!row) return null;

    let revision: number;
    let membershipVersion: number;
    let actorId: string;
    let requestHash: string;
    let operationRef: string;
    let deviceSetHash: string;
    try {
      if (row.get('command_kind') !== 'SENDER_KEY_DISTRIBUTION') {
        throw new Error('INVALID_REGISTRATION_KIND');
      }

      revision = admissionLong(row.get('revision'), 1);
      membershipVersion = admissionLong(row.get('membership_version'), 1);
      actorId = admissionUuid(String(row.get('actor_id')));

      const storedHash: unknown = row.get('request_hash');
      const storedRef: unknown = row.get('operation_ref');
      const storedDeviceHash: unknown = row.get('device_set_hash');
      if (
        typeof storedHash !== 'string' ||
        !HASH.test(storedHash) ||
        typeof storedRef !== 'string' ||
        typeof storedDeviceHash !== 'string' ||
        !HASH.test(storedDeviceHash) ||
        membershipVersion - 1 > revision
      ) {
        throw new Error('INVALID_REGISTRATION_RECORD');
      }

      assertAdmissionKey(storedRef);

      if (!storedRef.startsWith(`send:${senderDeviceId}:`)) {
        throw new Error('INVALID_REGISTRATION_REFERENCE');
      }

      requestHash = storedHash;
      operationRef = storedRef;
      deviceSetHash = storedDeviceHash;
    } catch {
      throw new ServiceUnavailableException('INVALID_GROUP_KEY_REGISTRATION');
    }

    const receipt = await this.admission.readReceipt(chatId, operationRef);
    if (
      !receipt ||
      receipt.commandKind !== 'SEND' ||
      receipt.actorId !== actorId ||
      receipt.requestHash !== requestHash ||
      receipt.revision !== revision ||
      receipt.membershipVersion !== membershipVersion ||
      receipt.operationRef !== operationRef
    ) {
      throw new ServiceUnavailableException('GROUP_KEY_RECEIPT_MISMATCH');
    }

    return Object.freeze({
      senderDeviceId,
      distributionId,
      deviceSetHash,
      receipt,
    });
  }

  async tryAcceptDistribution(
    expected: ChatAdmissionSnapshot,
    command: ChatAdmissionCommand,
    context: GroupKeyContext,
  ): Promise<ChatAdmissionResult> {
    admissionUuid(expected.chatId);
    admissionNumber(expected.revision, 0);
    admissionNumber(expected.membershipVersion, 1);
    admissionUuid(context.senderDeviceId);
    admissionUuid(context.distributionId);
    assertAdmissionCommand(command);
    if (
      command.commandKind !== 'SEND' ||
      !command.entryKey.startsWith(`send:${context.senderDeviceId}:`) ||
      typeof context.deviceSetHash !== 'string' ||
      !HASH.test(context.deviceSetHash)
    ) {
      throw new ConflictException('INVALID_GROUP_DISTRIBUTION_COMMAND');
    }

    if (expected.membershipVersion - 1 > expected.revision) {
      throw new ConflictException('INVALID_MEMBERSHIP_VERSION');
    }

    const members = canonicalMembers(expected.members);
    if (!members.some((member) => member.userId === command.actorId)) {
      throw new ConflictException('GROUP_DISTRIBUTION_SENDER_NOT_MEMBER');
    }

    const existing = await this.readRegistration(
      expected.chatId,
      context.senderDeviceId,
      context.distributionId,
    );
    if (existing) return this.accepted(existing, command, context);

    const previousReceipt = await this.admission.readReceipt(
      expected.chatId,
      command.entryKey,
    );
    if (previousReceipt) {
      return this.resolveExistingReceipt(expected.chatId, command, context);
    }

    if (expected.revision === Number.MAX_SAFE_INTEGER) {
      throw new ConflictException('CHAT_VERSION_EXHAUSTED');
    }

    const revision = expected.revision + 1;

    let applied = false;
    let outcomeUnknown = false;
    try {
      const result = await this.cassandra.client.execute(
        ACCEPT_DISTRIBUTION,
        [
          types.Long.fromNumber(revision),
          expected.chatId,
          types.Long.fromNumber(expected.revision),
          types.Long.fromNumber(expected.membershipVersion),
          JSON.stringify(members),
          expected.chatId,
          command.entryKey,
          types.Long.fromNumber(revision),
          types.Long.fromNumber(expected.membershipVersion),
          command.actorId,
          command.requestHash,
          command.operationRef,
          expected.chatId,
          this.registrationKey(context.senderDeviceId, context.distributionId),
          types.Long.fromNumber(revision),
          types.Long.fromNumber(expected.membershipVersion),
          command.actorId,
          command.requestHash,
          command.operationRef,
          context.deviceSetHash,
        ],
        CAS_WRITE,
      );

      applied = result.wasApplied();
    } catch {
      outcomeUnknown = true;
    }

    const stored = await this.readRegistration(
      expected.chatId,
      context.senderDeviceId,
      context.distributionId,
    );
    if (stored) return this.accepted(stored, command, context);

    if (outcomeUnknown || applied) {
      throw new ServiceUnavailableException(
        'GROUP_DISTRIBUTION_OUTCOME_UNKNOWN',
      );
    }

    const concurrentReceipt = await this.admission.readReceipt(
      expected.chatId,
      command.entryKey,
    );
    if (concurrentReceipt) {
      return this.resolveExistingReceipt(expected.chatId, command, context);
    }

    return { status: 'stale' };
  }

  private async resolveExistingReceipt(
    chatId: string,
    command: ChatAdmissionCommand,
    context: GroupKeyContext,
  ): Promise<ChatAdmissionResult> {
    const registration = await this.readRegistration(
      chatId,
      context.senderDeviceId,
      context.distributionId,
    );
    if (registration) return this.accepted(registration, command, context);
    throw new ConflictException('SEND_OPERATION_ALREADY_REGISTERED');
  }

  private accepted(
    registration: RegisteredGroupKey,
    command: ChatAdmissionCommand,
    context: GroupKeyContext,
  ): ChatAdmissionResult {
    const { receipt } = registration;

    if (
      registration.senderDeviceId !== context.senderDeviceId ||
      registration.distributionId !== context.distributionId ||
      registration.deviceSetHash !== context.deviceSetHash ||
      receipt.commandKind !== command.commandKind ||
      receipt.entryKey !== command.entryKey ||
      receipt.actorId !== command.actorId ||
      receipt.requestHash !== command.requestHash ||
      receipt.operationRef !== command.operationRef
    ) {
      throw new ConflictException('GROUP_DISTRIBUTION_ID_REUSED');
    }

    return {
      status: 'accepted',
      receipt,
    };
  }

  private registrationKey(
    senderDeviceId: string,
    distributionId: string,
  ): string {
    return `sender-key:${senderDeviceId}:${distributionId}`;
  }
}
