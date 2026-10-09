import { ConflictException, Injectable } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { computeChainHash, GENESIS_HASH } from './chain-hash';
import { CassandraService } from '@common/cassandra/cassandra.service';

const MAX_APPEND_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 5;
const BACKOFF_JITTER_MS = 20;

export type ChainEntryKind = 'signed' | 'server';

export interface ChainAppendInput {
  chatId: string;
  messageId: types.TimeUuid;
  messageHash: string;
  kind: ChainEntryKind;
}

export interface ChainPosition {
  chatSeq: number;
  chainHash: string;
}

interface ChainHead {
  chatSeq: number;
  chainHash: string;
}

@Injectable()
export class ChatChainService {
  constructor(private readonly cassandra: CassandraService) {}

  async append(input: ChainAppendInput): Promise<ChainPosition> {
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
      const head = await this.readHead(input.chatId);
      const chatSeq = head ? head.chatSeq + 1 : 1;
      const prevCheinHash = head ? head.chainHash : GENESIS_HASH;
      const chainHash = computeChainHash(
        chatSeq,
        prevCheinHash,
        input.messageHash,
      );

      const result = await this.cassandra.client.execute(
        `INSERT INTO chat_chain_log
           (chat_id, chat_seq, message_id, message_hash, chain_hash, kind)
         VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
        [
          input.chatId,
          types.Long.fromNumber(chatSeq),
          input.messageId,
          input.messageHash,
          chainHash,
          input.kind,
        ],
        { prepare: true, serialConsistency: types.consistencies.localSerial },
      );
      if (result.wasApplied()) {
        return { chatSeq, chainHash };
      }

      const existing = result.first();
      if (
        existing &&
        String(existing.get('messageId')) === input.messageId.toString()
      ) {
        return { chatSeq, chainHash: existing.get('chain_hash') as string };
      }

      await this.sleep(
        BACKOFF_BASE_MS * attempt + Math.random() * BACKOFF_JITTER_MS,
      );
    }
    throw new ConflictException('CHAT_CHAIN_BUSY: повторите отправку');
  }

  private async readHead(chatId: string): Promise<ChainHead | null> {
    const result = await this.cassandra.client.execute(
      `SELECT chat_seq, chain_hash FROM chat_chain_log WHERE chat_id = ? LIMIT 1`,
      [chatId],
      { prepare: true, consistency: types.consistencies.localSerial },
    );
    if (result.rowLength === 0) return null;
    const row = result.first();

    return {
      chatSeq: (row.get('chat_seq') as types.Long).toNumber(),
      chainHash: row.get('chain_hash') as string,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
