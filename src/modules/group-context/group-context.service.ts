import { validDevicePublicKey } from '@modules/messages/e2e/protocol/device-public-key';
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
import { WriterDeviceKeysService } from '@modules/message-writer/writer-device-keys.service';
import type { DeviceRoster } from '@modules/message-writer/writer-device-keys.service';
import { computeGroupDeviceSetHash } from '@modules/messages/e2e/protocol/group-device-set';
import { E2EE_LIMIT } from '@modules/messages/e2e/protocol/encrypted-message.contract';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HASH = /^[0-9a-f]{64}$/;

function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) {
    throw new BadRequestException('INVALID_GROUP_CONTEXT_REQUEST');
  }

  return value;
}

function invalidDirectory(): never {
  throw new ServiceUnavailableException('INVALID_DIRECTORY_RESPONSE');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface GroupContextResponse {
  readonly chatId: string;
  readonly senderDeviceId: string;
  readonly membershipVersion: number;
  readonly deviceSetHash: string;
  readonly rosters: readonly DeviceRoster[];
  readonly recipients: readonly {
    readonly userId: string;
    readonly deviceId: string;
  }[];
}

@Injectable()
export class GroupContextService {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly admission: ChatAdmissionRepository,
    private readonly keys: WriterDeviceKeysService,
  ) {}

  async get(
    userId: string,
    chatIdInput: unknown,
    query: unknown,
  ): Promise<GroupContextResponse> {
    uuid(userId);

    const chatId = uuid(chatIdInput);
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw new BadRequestException('INVALID_GROUP_CONTEXT_REQUEST');
    }

    const input = query as Record<string, unknown>;
    const fields = Object.keys(input);
    if (fields.length !== 1 || fields[0] !== 'senderDeviceId') {
      throw new BadRequestException('INVALID_GROUP_CONTEXT_REQUEST');
    }

    const senderDeviceId = uuid(input.senderDeviceId);
    const before = await this.admission.readState(chatId);
    if (!before || !before.members.some((member) => member.userId === userId)) {
      throw new NotFoundException('CHAT_NOT_FOUND');
    }

    await this.assertGroup(chatId);

    const memberIds = before.members.map((member) => member.userId);
    if (
      memberIds.length === 0 ||
      memberIds.length > 64 ||
      new Set(memberIds).size !== memberIds.length
    ) {
      throw new ServiceUnavailableException('INVALID_CHAT_MEMBER_SNAPSHOT');
    }

    const source = await this.keys.getRosters(memberIds);

    const expected = new Set(memberIds);
    const seenDevices = new Set<string>();
    const rosters: DeviceRoster[] = [];

    let senderFound = false;
    for (const roster of source) {
      if (
        !roster ||
        !expected.delete(roster.userId) ||
        typeof roster.rosterHash !== 'string' ||
        !HASH.test(roster.rosterHash) ||
        !Array.isArray(roster.devices) ||
        roster.devices.length === 0 ||
        roster.devices.length > 64
      )
        return invalidDirectory();

      const devices = roster.devices
        .map((device) => {
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

          if (roster.userId === userId && device.deviceId === senderDeviceId)
            senderFound = true;

          return {
            deviceId: device.deviceId,
            signingPublicKey: device.signingPublicKey,
            identityKey: device.identityKey,
            registrationId: device.registrationId,
          };
        })
        .sort((a, b) => compare(a.deviceId, b.deviceId));

      rosters.push({
        userId: roster.userId,
        rosterHash: roster.rosterHash,
        devices,
      });
    }

    if (expected.size !== 0) return invalidDirectory();

    if (!senderFound) {
      throw new ForbiddenException('DEVICE_NOT_ACTIVE');
    }

    rosters.sort((a, b) => compare(a.userId, b.userId));

    const recipients = rosters.flatMap((roster) =>
      roster.devices
        .filter(
          (device) =>
            !(roster.userId === userId && device.deviceId === senderDeviceId),
        )
        .map((device) => ({
          userId: roster.userId,
          deviceId: device.deviceId,
        })),
    );

    if (recipients.length === 0) {
      throw new ConflictException('GROUP_HAS_NO_RECIPIENTS');
    }

    if (recipients.length > E2EE_LIMIT.maxRecipients) {
      throw new ConflictException('E2EE_RECIPIENT_LIMIT_EXCEEDED');
    }

    const after = await this.admission.readState(chatId);
    if (!after || !after.members.some((member) => member.userId === userId)) {
      throw new NotFoundException('CHAT_NOT_FOUND');
    }

    if (
      before.membershipVersion !== after.membershipVersion ||
      JSON.stringify(before.members) !== JSON.stringify(after.members)
    ) {
      throw new ConflictException('GROUP_CONTEXT_CHANGED');
    }

    return {
      chatId,
      senderDeviceId,
      membershipVersion: before.membershipVersion,
      deviceSetHash: computeGroupDeviceSetHash(
        chatId,
        before.membershipVersion,
        rosters,
      ),
      rosters,
      recipients,
    };
  }

  private async assertGroup(chatId: string): Promise<void> {
    let chatType: unknown;
    try {
      const result = await this.cassandra.client.execute(
        'SELECT type FROM chats WHERE chat_id = ?',
        [chatId],
        { prepare: true, consistency: types.consistencies.localQuorum },
      );

      chatType = result.first()?.get('type');
    } catch {
      throw new ServiceUnavailableException('CHAT_METADATA_UNAVAILABLE');
    }

    if (chatType === 'direct') {
      throw new ConflictException('GROUP_CHAT_REQUIRED');
    }

    if (chatType !== 'group') {
      throw new ServiceUnavailableException('INVALID_CHAT_METADATA');
    }
  }
}
