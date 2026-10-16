import { BadRequestException } from '@nestjs/common';

export interface WriterAttachment {
  mediaId: string;
  type: string;
  url?: string;
  fileName?: string;
  sizeBytes?: number;
  placeholder?: string;
}

export interface SignedProof {
  senderDeviceId: string;
  seq: number;
  prevHash: string;
  signature: string;
}

export interface AppendCommand {
  version: 1;
  senderId: string;
  message: {
    chatId: string;
    content?: string;
    attachments?: WriterAttachment[];
  };
  viaAssistant: boolean;
  signed?: SignedProof;
  messageId?: string;
}

export interface StoredMessage {
  chatId: string;
  messageId: string;
  senderId: string;
  content?: string;
  attachments: WriterAttachment[];
  type: string;
  createdAt: string;
  viaAssistant: boolean;
  chatSeq: number;
  chainHash: string;
  messageHash: string;
  editOf: string | null;
  senderDeviceId: string | null;
  seq: number | null;
  prevHash: string | null;
  signature: string | null;
  replayed: boolean;
}

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const TIME_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HASH = /^[0-9a-f]{64}$/;

function fail(): never {
  throw new BadRequestException('INVALID_APPEND_COMMAND');
}

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const result = value as Record<string, unknown>;

  if (Object.keys(result).some((key) => !keys.includes(key))) fail();
  return result;
}

function text(value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.length || value.length > max) fail();
  if (pattern && !pattern.test(value)) fail();
  return value;
}

function optionalText(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : text(value, max);
}

function number(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    fail();
  return value;
}

export function parseAppendCommand(value: unknown): AppendCommand {
  const v = record(value, [
    'version',
    'senderId',
    'message',
    'viaAssistant',
    'signed',
    'messageId',
  ]);
  if (v.version !== 1 || typeof v.viaAssistant !== 'boolean') fail();
  const message = record(v.message, ['chatId', 'content', 'attachments']);
  let attachments: WriterAttachment[] | undefined;

  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments) || message.attachments.length > 10)
      fail();

    const values: unknown[] = message.attachments;
    attachments = values.map((value) => {
      const a = record(value, [
        'mediaId',
        'type',
        'url',
        'fileName',
        'sizeBytes',
        'placeholder',
      ]);
      const type = text(a.type, 10);
      if (!['image', 'file', 'gif', 'video'].includes(type)) fail();

      return {
        mediaId: text(a.mediaId, 36, UUID),
        type,
        url: optionalText(a.url, 4096),
        fileName: optionalText(a.fileName, 512),
        sizeBytes:
          a.sizeBytes === undefined ? undefined : number(a.sizeBytes, 0),
        placeholder: optionalText(a.placeholder, 16384),
      };
    });
  }

  const content = optionalText(message.content, 4000);
  if (!content && !attachments?.length) fail();

  let signed: SignedProof | undefined;
  if (v.signed !== undefined) {
    const s = record(v.signed, [
      'senderDeviceId',
      'seq',
      'prevHash',
      'signature',
    ]);
    if (v.messageId !== undefined || v.viaAssistant) fail();
    signed = {
      senderDeviceId: text(s.senderDeviceId, 36, UUID),
      seq: number(s.seq, 1),
      prevHash: text(s.prevHash, 64, HASH),
      signature: text(s.signature, 88, /^[A-Za-z0-9+/]{86}==$/),
    };
  }

  return {
    version: 1,
    senderId: text(v.senderId, 36, UUID),
    message: { chatId: text(message.chatId, 36, UUID), content, attachments },
    viaAssistant: v.viaAssistant,
    signed,
    messageId: signed ? undefined : text(v.messageId, 36, TIME_UUID),
  };
}

export const MUTATION_PREFIX = 'tapik.mutation.v1\n';
export type Mutation =
  | { type: 'EDIT'; editOf: string; text: string }
  | { type: 'DELETE'; editOf: string };

export function readMutation(content: string | undefined): Mutation | null {
  if (!content?.startsWith(MUTATION_PREFIX)) return null;
  let parsed: unknown;

  try {
    parsed = JSON.parse(content.slice(MUTATION_PREFIX.length));
  } catch {
    fail();
  }

  if (!Array.isArray(parsed)) fail();
  const values: unknown[] = parsed;
  const [version, type, editOf, replacement] = values;
  if (version !== 1 || (type !== 'EDIT' && type !== 'DELETE')) fail();
  const id = text(editOf, 36, TIME_UUID);
  if (values.length !== (type === 'EDIT' ? 4 : 3)) fail();
  if (content !== MUTATION_PREFIX + JSON.stringify(values)) fail();
  return type === 'EDIT'
    ? { type, editOf: id, text: text(replacement, 3500) }
    : { type, editOf: id };
}

export function isServiceMessageType(type: unknown): boolean {
  return type === 'CHECKPOINT' || type === 'EDIT' || type === 'DELETE';
}
