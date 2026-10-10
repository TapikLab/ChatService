import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  CHECKPOINT_PREFIX,
  createCheckpoint,
  encodeCheckpoint,
  readCheckpoint,
  verifyCheckpoint,
} from '../../src/modules/messages/signing/checkpoint';
import { rawPublicKey } from './client';

describe('checkpoint protocol', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const input = {
    chatId: randomUUID(),
    chatSeq: 50,
    chainHash: 'a'.repeat(64),
    userId: randomUUID(),
    deviceId: randomUUID(),
  };
  it('round-trips canonical signed content', () => {
    const cp = createCheckpoint(input, privateKey);
    expect(readCheckpoint(encodeCheckpoint(cp))).toEqual(cp);
    expect(verifyCheckpoint(cp, rawPublicKey(privateKey))).toBe(true);
  });
  it('rejects whitespace and trailing bytes', () => {
    const content = encodeCheckpoint(createCheckpoint(input, privateKey));
    expect(() => readCheckpoint(`${content} `)).toThrow(
      'NON_CANONICAL_CHECKPOINT',
    );
    expect(() => readCheckpoint(content.replace('[', '[ '))).toThrow(
      'NON_CANONICAL_CHECKPOINT',
    );
  });
  it('rejects oversized reserved content instead of treating it as ordinary text', () => {
    expect(() => readCheckpoint(CHECKPOINT_PREFIX + 'x'.repeat(2048))).toThrow(
      'INVALID_CHECKPOINT',
    );
    expect(readCheckpoint('ordinary'.repeat(500))).toBeNull();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects sequence %s before signing',
    (chatSeq) => {
      expect(() => createCheckpoint({ ...input, chatSeq }, privateKey)).toThrow(
        'INVALID_CHECKPOINT_INPUT',
      );
    },
  );
  it('rejects malformed input and a non-Ed25519 key', () => {
    expect(() =>
      createCheckpoint({ ...input, chainHash: 'invalid' }, privateKey),
    ).toThrow('INVALID_CHECKPOINT_INPUT');
    const wrongKey = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    }).privateKey;
    expect(() => createCheckpoint(input, wrongKey)).toThrow(
      'ED25519_PRIVATE_KEY_REQUIRED',
    );
    expect(() => readCheckpoint(CHECKPOINT_PREFIX + '{')).toThrow(
      'INVALID_CHECKPOINT',
    );
  });
});
