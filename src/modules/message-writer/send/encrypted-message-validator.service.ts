import { validDevicePublicKey } from '@modules/messages/e2e/protocol/device-public-key';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import {
  E2EE_LIMIT,
  prepareEncryptedMessage,
} from '@modules/messages/e2e/protocol/encrypted-message.contract';
import type { PreparedEncryptedMessage } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { computeGroupDeviceSetHash } from '@modules/messages/e2e/protocol/group-device-set';
import { verifyEd25519 } from '@modules/messages/signing/message-signature';
import { WriterDeviceKeysService } from '@modules/message-writer/writer-device-keys.service';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import { GroupKeyAdmissionRepository } from '@modules/message-writer/admission/group-key-admission.repository';
import type { ChatAdmissionSnapshot } from '@modules/message-writer/admission/chat-admission.contract';

export interface ValidatedEncryptedMessage {
  readonly senderId: string;
  readonly prepared: PreparedEncryptedMessage;
  readonly memberIds: readonly string[];
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HASH = /^[0-9a-f]{64}$/;

function invalidDirectory(): never {
  throw new ServiceUnavailableException('INVALID_DIRECTORY_RESPONSE');
}

@Injectable()
export class EncryptedMessageValidator {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly keys: WriterDeviceKeysService,
    private readonly admission: ChatAdmissionRepository,
    private readonly groupKeys: GroupKeyAdmissionRepository,
  ) {}

  async validate(
    senderId: string,
    body: unknown,
  ): Promise<ValidatedEncryptedMessage> {
    return this.validatePrepared(
      senderId,
      prepareEncryptedMessage(senderId, body),
    );
  }

  async validatePrepared(
    senderId: string,
    prepared: PreparedEncryptedMessage,
  ): Promise<ValidatedEncryptedMessage> {
    const snapshot = await this.admission.readState(prepared.message.chatId);
    if (!snapshot) {
      throw new ServiceUnavailableException('CHAT_ADMISSION_NOT_INITIALIZED');
    }

    return this.validateSnapshot(senderId, prepared, snapshot);
  }

  async validateSnapshot(
    senderId: string,
    prepared: PreparedEncryptedMessage,
    snapshot: ChatAdmissionSnapshot,
  ): Promise<ValidatedEncryptedMessage> {
    const { message } = prepared;
    const { envelope } = message;

    if (snapshot.chatId !== message.chatId) {
      throw new ConflictException('CHAT_SNAPSHOT_MISMATCH');
    }

    const memberIds = snapshot.members.map((member) => member.userId);
    if (
      memberIds.length === 0 ||
      memberIds.length > 64 ||
      new Set(memberIds).size !== memberIds.length
    ) {
      throw new ServiceUnavailableException('INVALID_CHAT_MEMBER_SNAPSHOT');
    }

    if (!memberIds.includes(senderId)) {
      throw new ForbiddenException('NOT_A_CHAT_MEMBER');
    }

    const chatType = await this.readChatType(message.chatId);
    if (chatType === 'group' && envelope.mode !== 'e2e_group_v1') {
      throw new ConflictException('GROUP_ENVELOPE_REQUIRED');
    }
    if (chatType === 'direct' && envelope.mode !== 'e2e_v1') {
      throw new ConflictException('PAIRWISE_ENVELOPE_REQUIRED');
    }

    if (
      envelope.mode === 'e2e_group_v1' &&
      envelope.membershipVersion !== snapshot.membershipVersion
    ) {
      throw new ConflictException('GROUP_MEMBERSHIP_CHANGED');
    }

    const rosters = await this.keys.getRosters(memberIds);

    const remainingUsers = new Set(memberIds);
    const expectedAddresses = new Set<string>();
    const seenDevices = new Set<string>();

    let signingPublicKey: string | undefined;
    for (const roster of rosters) {
      if (
        !roster ||
        !remainingUsers.delete(roster.userId) ||
        typeof roster.rosterHash !== 'string' ||
        !HASH.test(roster.rosterHash) ||
        !Array.isArray(roster.devices) ||
        roster.devices.length === 0 ||
        roster.devices.length > 64
      )
        return invalidDirectory();

      for (const device of roster.devices) {
        if (
          !device ||
          typeof device.deviceId !== 'string' ||
          !UUID.test(device.deviceId) ||
          seenDevices.has(device.deviceId) ||
          !validDevicePublicKey(device.signingPublicKey, 'signing') ||
          !validDevicePublicKey(device.identityKey, 'identity') ||
          !Number.isSafeInteger(device.registrationId) ||
          device.registrationId < 1 ||
          device.registrationId > 16383
        )
          return invalidDirectory();

        seenDevices.add(device.deviceId);
        if (
          roster.userId === senderId &&
          device.deviceId === message.senderDeviceId
        ) {
          signingPublicKey = device.signingPublicKey;
        } else {
          expectedAddresses.add(`${roster.userId}:${device.deviceId}`);
        }
      }
    }

    if (remainingUsers.size !== 0) return invalidDirectory();

    if (!signingPublicKey) {
      throw new ForbiddenException('DEVICE_NOT_ACTIVE');
    }

    if (
      !verifyEd25519(
        signingPublicKey,
        prepared.signingPayload,
        message.signature,
      )
    ) {
      throw new ForbiddenException('INVALID_MESSAGE_SIGNATURE');
    }

    if (expectedAddresses.size > E2EE_LIMIT.maxRecipients) {
      throw new ConflictException('E2EE_RECIPIENT_LIMIT_EXCEEDED');
    }

    if (envelope.recipients.length !== expectedAddresses.size) {
      throw new ConflictException('E2EE_RECIPIENTS_CHANGED');
    }

    for (const recipient of envelope.recipients) {
      const address = `${recipient.userId}:${recipient.deviceId}`;

      if (!expectedAddresses.delete(address)) {
        throw new ConflictException('E2EE_RECIPIENTS_CHANGED');
      }
    }

    if (envelope.mode === 'e2e_group_v1') {
      const expectedHash = computeGroupDeviceSetHash(
        message.chatId,
        snapshot.membershipVersion,
        rosters,
      );

      if (envelope.deviceSetHash !== expectedHash) {
        throw new ConflictException('GROUP_DEVICE_SET_CHANGED');
      }

      if (envelope.kind === 'message') {
        const registration = await this.groupKeys.readRegistration(
          message.chatId,
          message.senderDeviceId,
          envelope.distributionId,
        );
        if (!registration) {
          throw new ConflictException('GROUP_KEY_NOT_REGISTERED');
        }

        if (
          registration.receipt.actorId !== senderId ||
          registration.receipt.membershipVersion !==
            snapshot.membershipVersion ||
          registration.deviceSetHash !== expectedHash
        ) {
          throw new ConflictException('GROUP_KEY_ROTATION_REQUIRED');
        }

        if (registration.receipt.revision > snapshot.revision) {
          throw new ServiceUnavailableException(
            'CHAT_STATE_CHANGED_RETRY_SAME_REQUEST',
          );
        }

        const distributionSeq = Number(
          registration.receipt.operationRef.split(':')[2],
        );
        if (!Number.isSafeInteger(distributionSeq) || distributionSeq < 1)
          return invalidDirectory();

        if (message.seq <= distributionSeq) {
          throw new ConflictException('SEND_OPERATION_REUSED');
        }
      }
    }

    return Object.freeze({
      senderId,
      prepared,
      memberIds: Object.freeze(memberIds),
    });
  }

  private async readChatType(chatId: string): Promise<'direct' | 'group'> {
    let value: unknown;
    try {
      const result = await this.cassandra.client.execute(
        'SELECT type FROM chats WHERE chat_id = ?',
        [chatId],
        { prepare: true, consistency: types.consistencies.localQuorum },
      );

      value = result.first()?.get('type');
    } catch {
      throw new ServiceUnavailableException('CHAT_METADATA_UNAVAILABLE');
    }

    if (value !== 'direct' && value !== 'group') {
      throw new ServiceUnavailableException('INVALID_CHAT_METADATA');
    }

    return value;
  }
}
