import { ConflictException, Injectable } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { computeChainHash, GENESIS_HASH } from './chain-hash';
import { CassandraService } from '@common/cassandra/cassandra.service';

const MAX_ATTEMPTS = 16;

const READ_OPTIONS = {
  prepare: true,
  consistency: types.consistencies.localSerial,
};

const CAS_OPTIONS = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  serialConsistency: types.consistencies.localSerial,
};

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

interface Reservation {
  chatSeq: number;
  prevChainHash: string;
}

@Injectable()
export class ChatChainService {
  constructor(private readonly cassandra: CassandraService) {}

  async append(input: ChainAppendInput): Promise<ChainPosition> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const reservation = await this.readReservation(input);
      if (!reservation) {
        const candidate = await this.nextPosition(input.chatId);

        await this.cassandra.client.execute(
          `INSERT INTO chat_chain_claims 
          (chat_id, message_id, message_hash, chat_seq, prev_chain_hash)
           VALUES (?, ?, ?, ?, ?) IF NOT EXISTS`,
          [
            input.chatId,
            input.messageId,
            input.messageHash,
            types.Long.fromNumber(candidate.chatSeq),
            candidate.prevChainHash,
          ],
          CAS_OPTIONS,
        );

        continue;
      }

      const chainHash = computeChainHash(
        reservation.chatSeq,
        reservation.prevChainHash,
        input.messageHash,
      );

      const result = await this.cassandra.client.execute(
        `INSERT INTO chat_chain_log
           (chat_id, chat_seq, message_id, message_hash, chain_hash, kind)
         VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
        [
          input.chatId,
          types.Long.fromNumber(reservation.chatSeq),
          input.messageId,
          input.messageHash,
          chainHash,
          input.kind,
        ],
        CAS_OPTIONS,
      );
      if (result.wasApplied()) {
        return { chatSeq: reservation.chatSeq, chainHash };
      }

      const existing = result.first();
      if (
        existing &&
        String(existing.get('messageId')) === input.messageId.toString()
      ) {
        if (
          existing.get('message_hash') !== input.messageHash ||
          existing.get('chain_hash') !== chainHash
        ) {
          throw new ConflictException('CHAT_CHAIN_RECORD_MISMATCH');
        }

        return { chatSeq: reservation.chatSeq, chainHash };
      }

      const candidate = await this.nextPosition(input.chatId);
      if (candidate.chatSeq > reservation.chatSeq) {
        await this.cassandra.client.execute(
          `UPDATE chat_chain_claims
           SET chat_seq = ?, prev_chain_hash = ?
           WHERE chat_id = ? AND message_id = ?
           IF chat_seq = ? AND prev_chain_hash = ?`,
          [
            types.Long.fromNumber(candidate.chatSeq),
            candidate.prevChainHash,
            input.chatId,
            input.messageId,
            types.Long.fromNumber(reservation.chatSeq),
            reservation.prevChainHash,
          ],
          CAS_OPTIONS,
        );
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5 * (attempt + 1) + Math.random() * 20);
      });
    }
    throw new ConflictException('CHAT_CHAIN_BUSY: повторите отправку');
  }

  private async readReservation(
    input: ChainAppendInput,
  ): Promise<Reservation | null> {
    const result = await this.cassandra.client.execute(
      `SELECT message_hash, chat_seq, prev_chain_hash
       FROM chat_chain_claims
       WHERE chat_id = ? AND message_id = ?`,
      [input.chatId, input.messageId],
      READ_OPTIONS,
    );

    const row = result.first();
    if (!row) return null;

    if (row.get('message_hash') !== input.messageHash) {
      throw new ConflictException('MESSAGE_ID_REUSED');
    }

    return {
      chatSeq: this.toSequence(row.get('chat_seq') as types.Long),
      prevChainHash: row.get('prev_chain_hash') as string,
    };
  }

  private async nextPosition(chatId: string): Promise<Reservation> {
    const result = await this.cassandra.client.execute(
      `SELECT chat_seq, chain_hash
       FROM chat_chain_log
       WHERE chat_id = ? LIMIT 1`,
      [chatId],
      READ_OPTIONS,
    );

    const row = result.first();
    if (!row) {
      return { chatSeq: 1, prevChainHash: GENESIS_HASH };
    }

    const lastSeq = this.toSequence(row.get('chat_seq') as types.Long);
    if (lastSeq === Number.MAX_SAFE_INTEGER) {
      throw new ConflictException('CHAT_SEQUENCE_EXHAUSTED');
    }

    return {
      chatSeq: lastSeq + 1,
      prevChainHash: row.get('chain_hash') as string,
    };
  }
  private toSequence(value: types.Long): number {
    const result = value.toNumber();

    if (!Number.isSafeInteger(result) || result < 1) {
      throw new ConflictException('INVALID_CHAT_SEQUENCE');
    }

    return result;
  }
}
