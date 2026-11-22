import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { admissionNumber, admissionUuid } from '@modules/message-writer/admission/chat-admission.validation';

export type MembershipCommandKind = 'ADD_MEMBERS' | 'REMOVE_MEMBER';

export interface PreparedMembershipCommand {
  readonly chatId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly expectedMembershipVersion: number;
  readonly kind: MembershipCommandKind;
  readonly userIds: readonly string[];
  readonly entryKey: string;
  readonly requestHash: string;
}

function invalidCommand(): never {
  throw new BadRequestException('INVALID_MEMBERSHIP_COMMAND');
}

export function prepareMembershipCommand(
  actorId: string,
  body: unknown,
): PreparedMembershipCommand {
  admissionUuid(actorId);
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return invalidCommand();

  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length !== 5 ||
    !keys.includes('chatId') ||
    !keys.includes('requestId') ||
    !keys.includes('expectedMembershipVersion') ||
    !keys.includes('kind') ||
    !keys.includes('userIds')
  )
    return invalidCommand();

  const chatId = admissionUuid(input.chatId);
  const requestId = admissionUuid(input.requestId);
  const expectedMembershipVersion = admissionNumber(
    input.expectedMembershipVersion,
    1,
  );
  const kind = input.kind;
  if (kind !== 'ADD_MEMBERS' && kind !== 'REMOVE_MEMBER')
    return invalidCommand();

  const rawUserIds = input.userIds;
  if (
    !Array.isArray(rawUserIds) ||
    rawUserIds.length === 0 ||
    rawUserIds.length > 63 ||
    (kind === 'REMOVE_MEMBER' && rawUserIds.length !== 1)
  )
    return invalidCommand();

  const userIds: string[] = [];
  const seen = new Set<string>();
  for (const value of rawUserIds as unknown[]) {
    const userId = admissionUuid(value);
    if (seen.has(userId)) return invalidCommand();

    seen.add(userId);
    userIds.push(userId);
  }

  userIds.sort();
  const entryKey = `membership:${requestId}`;
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify([
        'tapik.membership-command.v1',
        actorId,
        chatId,
        requestId,
        expectedMembershipVersion,
        kind,
        userIds,
      ]),
      'utf8',
    )
    .digest('hex');

  return Object.freeze({
    chatId,
    requestId,
    actorId,
    expectedMembershipVersion,
    kind,
    userIds: Object.freeze(userIds),
    entryKey,
    requestHash,
  });
}
