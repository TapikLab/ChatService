import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ChatMember } from '@modules/message-writer/admission/chat-admission.contract';
import {
  admissionUuid,
  canonicalMembers,
} from '@modules/message-writer/admission/chat-admission.validation';

export interface PreparedCreateChat {
  readonly chatId: string;
  readonly creatorId: string;
  readonly type: 'direct' | 'group';
  readonly title: string | null;
  readonly members: readonly ChatMember[];
  readonly requestHash: string;
}

function invalidCreate(): never {
  throw new BadRequestException('INVALID_CREATE_CHAT');
}

export function prepareCreateChat(
  creatorId: string,
  body: unknown,
): PreparedCreateChat {
  admissionUuid(creatorId);
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return invalidCreate();

  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length !== 4 ||
    !keys.includes('chatId') ||
    !keys.includes('type') ||
    !keys.includes('title') ||
    !keys.includes('memberIds')
  )
    return invalidCreate();

  const chatId = admissionUuid(input.chatId);
  const type = input.type;
  if (type !== 'direct' && type !== 'group') return invalidCreate();

  let title: string | null;
  if (type === 'direct') {
    if (input.title !== null) return invalidCreate();

    title = null;
  } else {
    if (typeof input.title !== 'string' || input.title.length > 100)
      return invalidCreate();

    title = input.title.trim();
    if (title.length === 0) return invalidCreate();
  }

  const rawIds = input.memberIds;
  if (
    !Array.isArray(rawIds) ||
    rawIds.length > 63 ||
    (type === 'direct' && rawIds.length !== 1)
  )
    return invalidCreate();

  const seen = new Set<string>([creatorId]);
  const members: ChatMember[] = [{ userId: creatorId, role: 'admin' }];

  for (const value of rawIds as unknown[]) {
    const userId = admissionUuid(value);

    if (seen.has(userId)) return invalidCreate();

    seen.add(userId);
    members.push({ userId, role: 'member' });
  }

  const orderedMembers = canonicalMembers(members);
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify([
        'tapik.creat-chat.v1',
        creatorId,
        chatId,
        type,
        title,
        orderedMembers,
      ]),
      'utf8',
    )
    .digest('hex');

  return Object.freeze({
    chatId,
    creatorId,
    type,
    title,
    members: orderedMembers,
    requestHash,
  });
}
