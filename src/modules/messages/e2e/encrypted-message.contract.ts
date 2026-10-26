import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export type SignalPacketType = 'prekey' | 'signal';

export interface EncryptedRecipient {
  readonly userId: string;
  readonly deviceId: string;
  readonly messageType: SignalPacketType;
  readonly payload: string;
}

export interface EncryptedEnvelope {
  readonly mode: 'e2e_v1';
  readonly recipients: readonly EncryptedRecipient[];
}

export interface SendEncryptedMessage {
  readonly chatId: string;
  readonly senderDeviceId: string;
  readonly seq: number;
  readonly prevHash: string;
  readonly signature: string;
  readonly envelope: EncryptedEnvelope;
}

export interface PreparedEncryptedMessage {
  readonly message: SendEncryptedMessage;
  readonly serializedEnvelope: string;
  readonly contentHash: string;
  readonly signingPayload: string;
  readonly messageHash: string;
}

export const E2EE_LIMIT = Object.freeze({
  maxRecipients: 64,
  maxPacketBytes: 16 * 1024,
  maxTotalPacketBytes: 128 * 1024,
});

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const SIGNING_DOMAIN = 'tapik.msg.e2e.v1';

function invalid(): never {
  throw new BadRequestException('INVALID_E2EE_MESSAGE');
}

function tooLarge(): never {
  throw new PayloadTooLargeException('E2EE_MESSAGE_TOO_LARGE');
}

function exactObject(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalid();

  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);

  if (
    actualKeys.length !== allowedKeys.length ||
    actualKeys.some((key) => !allowedKeys.includes(key))
  )
    return invalid();

  return record;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value))
    return invalid();

  return value;
}

function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    return invalid();

  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !HASH.test(value))
    return invalid();

  return value;
}

function signature(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 88) return invalid();

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== value)
    return invalid();

  return value;
}

function packetType(value: unknown): SignalPacketType {
  if (value !== 'prekey' && value !== 'signal') {
    return invalid();
  }

  return value;
}

function packet(value: unknown): { encoded: string; byteLength: number } {
  if (typeof value !== 'string' || value.length === 0) return invalid();

  const maxEncodedLength = 4 * Math.ceil(E2EE_LIMIT.maxPacketBytes / 3);
  if (value.length > maxEncodedLength) return tooLarge();

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > E2EE_LIMIT.maxPacketBytes) return tooLarge();
  if (decoded.length === 0 || decoded.toString('base64') !== value)
    return invalid();

  return {
    encoded: value,
    byteLength: decoded.length,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function prepareEncryptedMessage(
  senderId: string,
  value: unknown,
): PreparedEncryptedMessage {
  const authenticatedSenderId = uuid(senderId);
  const input = exactObject(value, [
    'chatId',
    'senderDeviceId',
    'seq',
    'prevHash',
    'signature',
    'envelope',
  ]);

  const chatId = uuid(input.chatId);
  const senderDeviceId = uuid(input.senderDeviceId);
  const seq = sequence(input.seq);
  const prevHash = hash(input.prevHash);
  const messageSignature = signature(input.signature);

  const envelope = exactObject(input.envelope, ['mode', 'recipients']);
  if (envelope.mode !== 'e2e_v1') return invalid();
  if (!Array.isArray(envelope.recipients) || envelope.recipients.length === 0)
    return invalid();
  if (envelope.recipients.length > E2EE_LIMIT.maxRecipients) return tooLarge();

  const recipients: EncryptedRecipient[] = [];

  let previousAddress = '';
  let totalPacketBytes = 0;
  for (const value of envelope.recipients) {
    const item = exactObject(value, [
      'userId',
      'deviceId',
      'messageType',
      'payload',
    ]);

    const userId = uuid(item.userId);
    const deviceId = uuid(item.deviceId);
    const messageType = packetType(item.messageType);

    const address = `${userId}:${deviceId}`;
    if (address <= previousAddress) {
      throw new BadRequestException('E2EE_RECIPIENTS_NOT_STRICTLY_SORTED');
    }
    previousAddress = address;

    const decodedPacket = packet(item.payload);
    totalPacketBytes += decodedPacket.byteLength;
    if (totalPacketBytes > E2EE_LIMIT.maxTotalPacketBytes) return tooLarge();

    recipients.push(
      Object.freeze({
        userId,
        deviceId,
        messageType,
        payload: decodedPacket.encoded,
      }),
    );
  }

  const parsedEnvelope: EncryptedEnvelope = Object.freeze({
    mode: 'e2e_v1',
    recipients: Object.freeze(recipients),
  });

  const serializedEnvelope = JSON.stringify([
    'e2e_v1',
    recipients.map((recipient) => [
      recipient.userId,
      recipient.deviceId,
      recipient.messageType,
      recipient.payload,
    ]),
  ]);
  const contentHash = sha256(serializedEnvelope);
  const signingPayload = JSON.stringify([
    SIGNING_DOMAIN,
    authenticatedSenderId,
    chatId,
    senderDeviceId,
    seq,
    prevHash,
    contentHash,
  ]);

  const message: SendEncryptedMessage = Object.freeze({
    chatId,
    senderDeviceId,
    seq,
    prevHash,
    signature: messageSignature,
    envelope: parsedEnvelope,
  });

  return Object.freeze({
    message,
    serializedEnvelope,
    contentHash,
    signingPayload,
    messageHash: sha256(signingPayload),
  });
}
