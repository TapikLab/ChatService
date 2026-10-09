import { GENESIS_HASH, sha256Hex } from './message-signature';

const CHAIN_DOMAIN = 'tapik.chain.v1';
const SERVER_MESSAGE_DOMAIN = 'tapik.srv.v1';

export { GENESIS_HASH };

export function computeChainHash(
  chatSeq: number,
  prevChainHash: string,
  messageHash: string,
): string {
  return sha256Hex(
    [CHAIN_DOMAIN, String(chatSeq), prevChainHash, messageHash].join('\n'),
  );
}

export function computeServerMessageHash(input: {
  chatId: string;
  messageId: string;
  senderId: string;
  contentHash: string;
}): string {
  return sha256Hex(
    [
      SERVER_MESSAGE_DOMAIN,
      input.chatId,
      input.messageId,
      input.senderId,
      input.contentHash,
    ].join('\n'),
  );
}
