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
} from '@modules/messages/e2e/encrypted-message.contract';
import type { PreparedEncryptedMessage } from '@modules/messages/e2e/encrypted-message.contract';
import { verifyEd25519 } from '@modules/messages/signing/message-signature';
import { WriterDeviceKeysService } from './writer-device-keys.service';

export interface ValidatedEncryptedMessage {
  readonly senderId: string;
  readonly prepared: PreparedEncryptedMessage;
  readonly memberIds: readonly string[];
}

const MAX_CHAT_MEMBERS = 64;
const READ_OPTIONS = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalidDirectory(): never {
  throw new ServiceUnavailableException('INVALID_DIRECTORY_RESPONSE');
}

function validSigningKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 44) {
    return false;
  }

  const decoded = Buffer.from(value, 'base64');

  return decoded.length === 32 && decoded.toString('base64') === value;
}

@Injectable()
export class EncryptedMessageValidator {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly keys: WriterDeviceKeysService,
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
    const { message } = prepared;
    const membership = await this.cassandra.client.execute(
      `SELECT user_id
       FROM chat_members
       WHERE chat_id = ? AND user_id = ?`,
      [message.chatId, senderId],
      READ_OPTIONS,
    );
    if (!membership.first()) {
      throw new ForbiddenException('NOT_A_CHAT_MEMBER');
    }

    const members = await this.cassandra.client.execute(
      `SELECT user_id
       FROM chat_members
       WHERE chat_id = ?
       LIMIT ?`,
      [message.chatId, MAX_CHAT_MEMBERS + 1],
      READ_OPTIONS,
    );
    if (members.rows.length > MAX_CHAT_MEMBERS) {
      throw new ConflictException('E2EE_CHAT_MEMBER_LIMIT_EXCEEDED');
    }

    const memberIds = members.rows.map((row) => String(row.get('user_id')));
    if (!memberIds.includes(senderId)) {
      throw new ForbiddenException('NOT_A_CHAT_MEMBER');
    }

    const rosters = await this.keys.getRosters(memberIds);
    const expectedAddresses = new Set<string>();
    const seenDevices = new Set<string>();

    let signingPublicKey: string | undefined;
    for (const roster of rosters) {
      for (const device of roster.devices) {
        if (
          typeof device.deviceId !== 'string' ||
          !UUID.test(device.deviceId) ||
          seenDevices.has(device.deviceId) ||
          !validSigningKey(device.signingPublicKey)
        ) {
          return invalidDirectory();
        }

        seenDevices.add(device.deviceId);
        const isSendingDevice =
          roster.userId === senderId &&
          device.deviceId === message.senderDeviceId;

        if (isSendingDevice) {
          signingPublicKey = device.signingPublicKey;
          continue;
        }

        expectedAddresses.add(`${roster.userId}:${device.deviceId}`);
      }
    }

    if (signingPublicKey === undefined) {
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

    const recipients = message.envelope.recipients;
    if (recipients.length !== expectedAddresses.size) {
      throw new ConflictException('E2EE_RECIPIENTS_CHANGED');
    }

    for (const recipient of recipients) {
      const address = `${recipient.userId}:${recipient.deviceId}`;

      if (!expectedAddresses.delete(address)) {
        throw new ConflictException('E2EE_RECIPIENTS_CHANGED');
      }
    }

    return Object.freeze({
      senderId,
      prepared,
      memberIds: Object.freeze(memberIds),
    });
  }
}
