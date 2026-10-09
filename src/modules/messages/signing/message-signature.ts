import { createHash, createPublicKey, verify } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

const SIGNING_DOMAIN = 'tapik.msg.v1';
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SigningInput {
  chatId: string;
  senderDeviceId: string;
  seq: number;
  prevHash: string;
  contentHash: string;
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function computeContentHash(
  content: string | undefined,
  attachments: { mediaId: string; type: string }[] | undefined,
): string {
  const attachmentPart = (attachments ?? [])
    .map((a) => `${a.mediaId}:${a.type}`)
    .join(',');
  return sha256Hex(`${content ?? ''}\n${attachmentPart}`);
}

export function buildSigningPayload(input: SigningInput): string {
  return [
    SIGNING_DOMAIN,
    input.chatId,
    input.senderDeviceId,
    String(input.seq),
    input.prevHash,
    input.contentHash,
  ].join('\n');
}

export function computeMessageHash(signingPayload: string): string {
  return sha256Hex(signingPayload);
}

export function verifyEd25519(
  publicKeyBase64: string,
  payload: string,
  signatureBase64: string,
): boolean {
  try {
    const rawKey = Buffer.from(publicKeyBase64, 'base64');
    const signature = Buffer.from(signatureBase64, 'base64');
    if (
      rawKey.length !== ED25519_PUBLIC_KEY_BYTES ||
      signature.length !== ED25519_SIGNATURE_BYTES
    ) {
      return false;
    }
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(payload, 'utf8'), key, signature);
  } catch {
    return false;
  }
}
