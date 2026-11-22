import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

export interface GroupRecipientAddress {
  readonly userId: string;
  readonly deviceId: string;
}

export interface GroupDistributionRecipient extends GroupRecipientAddress {
  readonly messageType: 'prekey' | 'signal';
  readonly payload: string;
}

interface GroupEnvelopeContext {
  readonly mode: 'e2e_group_v1';
  readonly membershipVersion: number;
  readonly deviceSetHash: string;
  readonly distributionId: string;
}

export interface GroupDistributionEnvelope extends GroupEnvelopeContext {
  readonly kind: 'distribution';
  readonly recipients: readonly GroupDistributionRecipient[];
}

export interface GroupMessageEnvelope extends GroupEnvelopeContext {
  readonly kind: 'message';
  readonly recipients: readonly GroupRecipientAddress[];
  readonly payload: string;
}

export type GroupEnvelope = GroupDistributionEnvelope | GroupMessageEnvelope;

export const GROUP_ENVELOPE_LIMIT = Object.freeze({
  maxRecipients: 64,
  maxPacketBytes: 16 * 1024,
  maxDistributionBytes: 128 * 1024,
  maxMessageBytes: 16 * 1024,
});

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HASH = /^[0-9a-f]{64}$/;

function invalid(): never {
  throw new BadRequestException('INVALID_GROUP_ENVELOPE');
}

function tooLarge(): never {
  throw new PayloadTooLargeException('GROUP_ENVELOPE_TOO_LARGE');
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid();

  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);

  if (
    keys.length !== expected.length ||
    !expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}

function readUuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value))
    return invalid();

  return value;
}

function readHash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !HASH.test(value))
    return invalid();

  return value;
}

function readMembershipVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    return invalid();

  return value;
}

function readPacket(
  value: unknown,
  maximumBytes: number,
): {
  readonly payload: string;
  readonly byteLength: number;
} {
  if (typeof value !== 'string' || value.length === 0) return invalid();

  const maximumEncodedLength = 4 * Math.ceil(maximumBytes / 3);

  if (value.length > maximumEncodedLength) return tooLarge();

  const bytes = Buffer.from(value, 'base64');

  if (bytes.length > maximumBytes) return tooLarge();

  if (bytes.length === 0 || bytes.toString('base64') !== value)
    return invalid();

  return {
    payload: value,
    byteLength: bytes.length,
  };
}

function readRecipientList(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) return invalid();

  if (value.length > GROUP_ENVELOPE_LIMIT.maxRecipients) return tooLarge();

  return value;
}

function assertAddressOrder(previous: string, current: string): void {
  if (current <= previous) {
    throw new BadRequestException('GROUP_RECIPIENTS_NOT_STRICTLY_SORTED');
  }
}

export function parseGroupEnvelope(value: unknown): GroupEnvelope {
  const input = readObject(value);
  if (
    input.mode !== 'e2e_group_v1' ||
    (input.kind !== 'distribution' && input.kind !== 'message')
  )
    return invalid();

  const commitKeys = [
    'mode',
    'kind',
    'membershipVersion',
    'deviceSetHash',
    'distributionId',
    'recipients',
  ] as const;

  assertKeys(
    input,
    input.kind === 'message' ? [...commitKeys, 'payload'] : commitKeys,
  );

  const context: GroupEnvelopeContext = Object.freeze({
    mode: 'e2e_group_v1',
    membershipVersion: readMembershipVersion(input.membershipVersion),
    deviceSetHash: readHash(input.deviceSetHash),
    distributionId: readUuid(input.distributionId),
  });
  const sourceRecipients = readRecipientList(input.recipients);

  let previousAddress = '';
  if (input.kind === 'distribution') {
    const recipients: GroupDistributionRecipient[] = [];
    let totalBytes = 0;

    for (const source of sourceRecipients) {
      const item = readObject(source);

      assertKeys(item, ['userId', 'deviceId', 'messageType', 'payload']);

      const userId = readUuid(item.userId);
      const deviceId = readUuid(item.deviceId);
      const address = `${userId}:${deviceId}`;

      assertAddressOrder(previousAddress, address);
      previousAddress = address;

      if (item.messageType !== 'prekey' && item.messageType !== 'signal')
        return invalid();

      const packet = readPacket(
        item.payload,
        GROUP_ENVELOPE_LIMIT.maxPacketBytes,
      );

      totalBytes += packet.byteLength;
      if (totalBytes > GROUP_ENVELOPE_LIMIT.maxDistributionBytes) tooLarge();

      recipients.push(
        Object.freeze({
          userId,
          deviceId,
          messageType: item.messageType,
          payload: packet.payload,
        }),
      );
    }

    return Object.freeze({
      ...context,
      kind: 'distribution',
      recipients: Object.freeze(recipients),
    });
  }

  const recipients: GroupRecipientAddress[] = [];
  for (const source of sourceRecipients) {
    const item = readObject(source);

    assertKeys(item, ['userId', 'deviceId']);

    const userId = readUuid(item.userId);
    const deviceId = readUuid(item.deviceId);
    const address = `${userId}:${deviceId}`;

    assertAddressOrder(previousAddress, address);
    previousAddress = address;

    recipients.push(
      Object.freeze({
        userId,
        deviceId,
      }),
    );
  }

  const packet = readPacket(
    input.payload,
    GROUP_ENVELOPE_LIMIT.maxMessageBytes,
  );

  return Object.freeze({
    ...context,
    kind: 'message',
    recipients: Object.freeze(recipients),
    payload: packet.payload,
  });
}

export function serializeGroupEnvelope(envelope: GroupEnvelope): string {
  const context = [
    envelope.mode,
    envelope.kind,
    envelope.membershipVersion,
    envelope.deviceSetHash,
    envelope.distributionId,
  ];

  if (envelope.kind === 'distribution') {
    return JSON.stringify([
      ...context,
      envelope.recipients.map((recipient) => [
        recipient.userId,
        recipient.deviceId,
        recipient.messageType,
        recipient.payload,
      ]),
    ]);
  }

  return JSON.stringify([
    ...context,
    envelope.recipients.map((recipient) => [
      recipient.userId,
      recipient.deviceId,
    ]),
    envelope.payload,
  ]);
}

export function decodeStoredGroupEnvelope(value: unknown): GroupEnvelope {
  if (!Array.isArray(value) || value[0] !== 'e2e_group_v1') return invalid();

  const kind: unknown = value[1];
  if (
    (kind !== 'distribution' && kind !== 'message') ||
    value.length !== (kind === 'distribution' ? 6 : 7)
  )
    return invalid();

  const packets: unknown = value[5];
  if (!Array.isArray(packets) || packets.length === 0) return invalid();
  if (packets.length > GROUP_ENVELOPE_LIMIT.maxRecipients) return tooLarge();

  const recipients = packets.map((packet: unknown) => {
    if (
      !Array.isArray(packet) ||
      packet.length !== (kind === 'distribution' ? 4 : 2)
    )
      return invalid();

    return kind === 'distribution'
      ? {
          userId: packet[0] as unknown,
          deviceId: packet[1] as unknown,
          messageType: packet[2] as unknown,
          payload: packet[3] as unknown,
        }
      : { userId: packet[0] as unknown, deviceId: packet[1] as unknown };
  });

  return parseGroupEnvelope({
    mode: value[0] as unknown,
    kind,
    membershipVersion: value[2] as unknown,
    deviceSetHash: value[3] as unknown,
    distributionId: value[4] as unknown,
    recipients,
    ...(kind === 'message' ? { payload: value[6] as unknown } : {}),
  });
}
