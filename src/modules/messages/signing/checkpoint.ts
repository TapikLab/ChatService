import { sign, type KeyObject } from 'node:crypto';
import { verifyEd25519 } from './message-signature';

export const CHECKPOINT_PREFIX = 'tapik.checkpoint.v1\n';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

export interface Checkpoint {
  type: 'CHECKPOINT';
  version: 1;
  chatId: string;
  chatSeq: number;
  chainHash: string;
  userId: string;
  deviceId: string;
  signature: string;
}

export type CheckpointInput = Pick<
  Checkpoint,
  'chatId' | 'chatSeq' | 'chainHash' | 'userId' | 'deviceId'
>;

function fields(checkpoint: CheckpointInput): readonly unknown[] {
  return [
    'CHECKPOINT',
    1,
    checkpoint.chatId,
    checkpoint.chatSeq,
    checkpoint.chainHash,
    checkpoint.userId,
    checkpoint.deviceId,
  ];
}

export function checkpointSingingPayload(checkpoint: CheckpointInput): string {
  return CHECKPOINT_PREFIX + JSON.stringify(fields(checkpoint));
}

export function encodeCheckpoint(checkpoint: Checkpoint): string {
  return (
    CHECKPOINT_PREFIX +
    JSON.stringify([...fields(checkpoint), checkpoint.signature])
  );
}

export function readCheckpoint(content: string | undefined): Checkpoint | null {
  if (!content?.startsWith(CHECKPOINT_PREFIX)) return null;
  if (content.length > 2048) throw new Error('INVALID_CHECKPOINT');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.substring(CHECKPOINT_PREFIX.length));
  } catch {
    throw new Error('INVALID_CHECKPOINT');
  }
  if (!Array.isArray(parsed) || parsed.length !== 8) {
    throw new Error('INVALID_CHECKPOINT');
  }

  const values: unknown[] = parsed;
  const [
    type,
    version,
    chatId,
    chatSeq,
    chainHash,
    userId,
    deviceId,
    signature,
  ] = values;

  if (
    type !== 'CHECKPOINT' ||
    version !== 1 ||
    typeof chatId !== 'string' ||
    !UUID.test(chatId) ||
    typeof chatSeq !== 'number' ||
    !Number.isSafeInteger(chatSeq) ||
    chatSeq < 1 ||
    typeof chainHash !== 'string' ||
    !HASH.test(chainHash) ||
    typeof userId !== 'string' ||
    !UUID.test(userId) ||
    typeof deviceId !== 'string' ||
    !UUID.test(deviceId) ||
    typeof signature !== 'string' ||
    !SIGNATURE.test(signature)
  ) {
    throw new Error('INVALID_CHECKPOINT');
  }

  const checkpoint: Checkpoint = {
    type,
    version,
    chatId,
    chatSeq,
    chainHash,
    userId,
    deviceId,
    signature,
  };

  if (encodeCheckpoint(checkpoint) !== content) {
    throw new Error('NON_CANONICAL_CHECKPOINT');
  }

  return checkpoint;
}

export function createCheckpoint(
  input: CheckpointInput,
  privatekey: KeyObject,
): Checkpoint {
  if (
    privatekey.type !== 'private' ||
    privatekey.asymmetricKeyType !== 'ed25519'
  ) {
    throw new Error('ED25519_PRIVATE_KEY_REQUIRED');
  }

  if (
    !UUID.test(input.chatId) ||
    !Number.isSafeInteger(input.chatSeq) ||
    input.chatSeq < 1 ||
    !HASH.test(input.chainHash) ||
    !UUID.test(input.userId) ||
    !UUID.test(input.deviceId)
  ) {
    throw new Error('INVALID_CHECKPOINT_INPUT');
  }

  return {
    ...input,
    type: 'CHECKPOINT',
    version: 1,
    signature: sign(
      null,
      Buffer.from(checkpointSingingPayload(input), 'utf8'),
      privatekey,
    ).toString('base64'),
  };
}

export function verifyCheckpoint(
  checkpoint: Checkpoint,
  publicKeyBase64: string,
): boolean {
  return verifyEd25519(
    publicKeyBase64,
    checkpointSingingPayload(checkpoint),
    checkpoint.signature,
  );
}
