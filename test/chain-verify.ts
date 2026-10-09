import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

const CHAIN_DOMAIN = 'tapik.chain.v1';

export interface ChainEntry {
  chatSeq: number | string;
  messageHash: string;
  chainHash: string;
}

export type ChainVerdict =
  | { ok: true; verified: number; anchored: boolean }
  | {
      ok: false;
      reason: 'GAP' | 'NOT_ASCENDING' | 'HASH_MISMATCH';
      atChatSeq: number;
    };

export function computeChainHash(
  chatSeq: number,
  prevChainHash: string,
  messageHash: string,
): string {
  return createHash('sha256')
    .update(
      [CHAIN_DOMAIN, String(chatSeq), prevChainHash, messageHash].join('\n'),
      'utf8',
    )
    .digest('hex');
}

/**
 * entries — по возрастанию chatSeq.
 * Если первая запись не seq=1 и anchorPrevChainHash не передан, первая запись
 * принимается как якорь (anchored=false), проверяются все последующие звенья.
 */
export function verifyChainIntegrity(
  entries: ChainEntry[],
  anchorPrevChainHash?: string,
): ChainVerdict {
  if (entries.length === 0) {
    return { ok: true, verified: 0, anchored: true };
  }

  const firstSeq = Number(entries[0].chatSeq);
  let prevChainHash: string | null =
    firstSeq === 1 ? GENESIS_HASH : (anchorPrevChainHash ?? null);
  const anchored = prevChainHash !== null;
  let prevSeq: number | null = null;

  for (const entry of entries) {
    const chatSeq = Number(entry.chatSeq);

    if (prevSeq !== null) {
      if (chatSeq <= prevSeq) {
        return { ok: false, reason: 'NOT_ASCENDING', atChatSeq: chatSeq };
      }
      if (chatSeq !== prevSeq + 1) {
        return { ok: false, reason: 'GAP', atChatSeq: chatSeq };
      }
    }

    if (prevChainHash !== null) {
      const expected = computeChainHash(
        chatSeq,
        prevChainHash,
        entry.messageHash,
      );
      if (expected !== entry.chainHash) {
        return { ok: false, reason: 'HASH_MISMATCH', atChatSeq: chatSeq };
      }
    }

    prevChainHash = entry.chainHash;
    prevSeq = chatSeq;
  }

  return { ok: true, verified: entries.length, anchored };
}
