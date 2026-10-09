import { ConflictException, Injectable } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { GENESIS_HASH } from './message-signature';

interface ChainState {
  lastSeq: number;
  lastHash: string;
  lastSignature: string;
  lastMessageId: types.TimeUuid;
}

export interface ChainClaimInput {
  chatId: string;
  deviceId: string;
  seq: number;
  prevHash: string;
  messageHash: string;
  signature: string;
}

@Injectable()
export class DeviceChainService {
  constructor(private readonly cassandra: CassandraService) {}

  async claim(input: ChainClaimInput): Promise<types.TimeUuid> {
    const state = await this.readState(input.chatId, input.deviceId);
    if (state && state.lastSeq === input.seq) {
      if (state.lastSignature === input.signature) {
        return state.lastMessageId;
      }
      throw new ConflictException(
        'SEQ_REUSED: seq уже использован с другим содержимым',
      );
    }

    const expectedSeq = state ? state.lastSeq + 1 : 1;
    const expectedPrevHash = state ? state.lastHash : GENESIS_HASH;
    if (input.seq !== expectedSeq || input.prevHash !== expectedPrevHash) {
      throw new ConflictException(
        `CHAIN_MISMATCH: ожидался seq=${expectedSeq} и prevHash=${expectedPrevHash}`,
      );
    }

    const messageId = types.TimeUuid.now();
    const applied = state
      ? await this.advance(input, state, messageId)
      : await this.init(input, messageId);
    if (applied) return messageId;

    const after = await this.readState(input.chatId, input.deviceId);
    if (
      after &&
      after.lastSeq === input.seq &&
      after.lastSignature === input.signature
    )
      return messageId;

    throw new ConflictException('CHAIN_RACE_LOST: повторите отправку');
  }

  private async readState(
    chatId: string,
    deviceId: string,
  ): Promise<ChainState | null> {
    const result = await this.cassandra.client.execute(
      `SELECT last_seq, last_hash, last_signature, last_message_id
       FROM device_chain_state WHERE chat_id = ? AND device_id = ?`,
      [chatId, deviceId],
      { prepare: true, consistency: types.consistencies.localSerial },
    );
    if (result.rowLength === 0) return null;

    const row = result.first();

    return {
      lastSeq: (row.get('last_seq') as types.Long).toNumber(),
      lastHash: row.get('last_hash') as string,
      lastSignature: row.get('last_signature') as string,
      lastMessageId: row.get('last_message_id') as types.TimeUuid,
    };
  }

  private async init(
    input: ChainClaimInput,
    messageId: types.TimeUuid,
  ): Promise<boolean> {
    const result = await this.cassandra.client.execute(
      `INSERT INTO device_chain_state
         (chat_id, device_id, last_seq, last_hash, last_signature, last_message_id)
       VALUES (?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
      [
        input.chatId,
        input.deviceId,
        types.Long.fromNumber(input.seq),
        input.messageHash,
        input.signature,
        messageId,
      ],
      { prepare: true, serialConsistency: types.consistencies.localSerial },
    );
    return result.wasApplied();
  }

  private async advance(
    input: ChainClaimInput,
    state: ChainState,
    messageId: types.TimeUuid,
  ): Promise<boolean> {
    const result = await this.cassandra.client.execute(
      `UPDATE device_chain_state
       SET last_seq = ?, last_hash = ?, last_signature = ?, last_message_id = ?
       WHERE chat_id = ? AND device_id = ?
       IF last_seq = ? AND last_hash = ?`,
      [
        types.Long.fromNumber(input.seq),
        input.messageHash,
        input.signature,
        messageId,
        input.chatId,
        input.deviceId,
        types.Long.fromNumber(state.lastSeq),
        state.lastHash,
      ],
      { prepare: true, serialConsistency: types.consistencies.localSerial },
    );
    return result.wasApplied();
  }
}
