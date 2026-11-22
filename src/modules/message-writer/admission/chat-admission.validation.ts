import { BadRequestException } from '@nestjs/common';
import { types } from 'cassandra-driver';
import type {
  ChatAdmissionCommand,
  ChatMember,
} from './chat-admission.contract';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export function invalidAdmission(): never {
  throw new BadRequestException('INVALID_CHAT_ADMISSION');
}

export function admissionUuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) {
    return invalidAdmission();
  }

  return value;
}

export function admissionNumber(value: unknown, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    return invalidAdmission();
  }

  return value;
}

export function admissionLong(value: unknown, minimum: number): number {
  if (!(value instanceof types.Long)) {
    return invalidAdmission();
  }

  const number = admissionNumber(value.toNumber(), minimum);

  if (!value.equals(types.Long.fromNumber(number))) {
    return invalidAdmission();
  }

  return number;
}

export function canonicalMembers(value: unknown): readonly ChatMember[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    return invalidAdmission();

  const ids = new Set<string>();
  const members: ChatMember[] = [];
  let hasAdmin = false;
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      return invalidAdmission();

    const member = item as Record<string, unknown>;
    const keys = Object.keys(member);
    if (keys.length !== 2 || !keys.includes('userId') || !keys.includes('role'))
      return invalidAdmission();

    const userId = admissionUuid(member.userId);
    const role = member.role;
    if (ids.has(userId) || (role !== 'admin' && role !== 'member'))
      return invalidAdmission();

    ids.add(userId);
    hasAdmin ||= role === 'admin';
    members.push(Object.freeze({ userId, role }));
  }

  if (!hasAdmin) return invalidAdmission();

  members.sort((firstMember, secondMember) =>
    firstMember.userId < secondMember.userId ? -1 : 1,
  );

  return Object.freeze(members);
}

export function assertAdmissionKey(key: string): void {
  if (typeof key !== 'string' || key.length > 100) return invalidAdmission();

  const parts = key.split(':');
  if (parts[0] === 'membership' && parts.length === 2) {
    admissionUuid(parts[1]);
    return;
  }

  if (
    parts[0] === 'send' &&
    parts.length === 3 &&
    /^[1-9][0-9]{0,15}$/.test(parts[2])
  ) {
    admissionUuid(parts[1]);
    admissionNumber(Number(parts[2]), 1);
    return;
  }

  return invalidAdmission();
}

export function assertAdmissionCommand(command: ChatAdmissionCommand): void {
  assertAdmissionKey(command.entryKey);
  admissionUuid(command.actorId);
  if (
    typeof command.requestHash !== 'string' ||
    !HASH.test(command.requestHash) ||
    command.operationRef !== command.entryKey
  )
    return invalidAdmission();

  if (command.commandKind === 'SEND') {
    if (!command.entryKey.startsWith('send:')) return invalidAdmission();

    return;
  }

  if (
    command.commandKind !== 'ADD_MEMBERS' &&
    command.commandKind !== 'REMOVE_MEMBER'
  )
    return invalidAdmission();

  if (!command.entryKey.startsWith('membership:')) return invalidAdmission();
}
