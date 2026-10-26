import {
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import type { RegisteredSendOperation } from './encrypted-send-operations.service';

export const DELIVERY_SHARD_COUNT = 256;

const SERIAL_READ = {
  prepare: true,
  consistency: types.consistencies.localSerial,
};

const WRITE_OPTIONS = {
  prepare: true,
  consistency: types.consistencies.localQuorum,
  isIdempotent: true,
};

export function deliveryShard(
  chatId: string,
  senderDeviceId: string,
  seq: number,
): number {
  const digest = createHash('sha256')
    .update(
      JSON.stringify(['tapik.delivery-shard.v1', chatId, senderDeviceId, seq]),
    )
    .digest();

  return digest.readUInt32BE(0) & DELIVERY_SHARD_COUNT;
}

@Injectable()
export class EncryptedDeliveryOutboxService implements OnModuleInit {
  constructor(private readonly cassandra: CassandraService) {}

  async onModuleInit(): Promise<void> {
    const keyspace = this.cassandra.client.keyspace;

    const table = await this.cassandra.client.execute(
      `SELECT default_time_to_live
       FROM system_schema.tables
       WHERE keyspace_name = ? AND table_name = ?`,
      [keyspace, 'e2e_delivery_pending'],
      { prepare: true },
    );

    if (table.first()?.get('default_time_to_live') !== 0) {
      throw new Error('NON_EXPIRING_TABLE_REQUIRED:e2e_delivery_pending');
    }

    const column = await this.cassandra.client.execute(
      `SELECT type
       FROM system_schema.columns
       WHERE keyspace_name = ?
         AND table_name = ?
         AND column_name = ?`,
      [keyspace, 'e2e_send_operations', 'delivery_state'],
      { prepare: true },
    );

    const columnType: unknown = column.first()?.get('type');
    if (columnType !== 'text' && columnType !== 'varchar') {
      throw new Error('SEND_OPERATIONS_DELIVERY_STATE_REQUIRED');
    }
  }

  async ensurePending(operation: RegisteredSendOperation): Promise<void> {
    const { prepared } = operation;
    const { message } = prepared;
    const result = await this.cassandra.client.execute(
      `SELECT
         state,
         delivery_state,
         sender_id,
         message_id,
         message_hash,
         signature
       FROM e2e_send_operations
       WHERE chat_id = ?
         AND sender_device_id = ?
         AND seq = ?`,
      [
        message.chatId,
        message.senderDeviceId,
        types.Long.fromNumber(message.seq),
      ],
      SERIAL_READ,
    );

    const row = result.first();
    if (
      String(row.get('sender_id')) !== operation.senderId ||
      String(row.get('message_id')) !== operation.messageId ||
      row.get('message_hash') !== prepared.messageHash ||
      row.get('signature') !== message.signature
    ) {
      throw new ServiceUnavailableException('OUTBOX_OPERATION_MISMATCH');
    }

    const state: unknown = row.get('state');
    const deliveryState: unknown = row.get('delivery_state');
    if (state !== 'REGISTERED' && state !== 'COMMITTED') {
      throw new ServiceUnavailableException('INVALID_SEND_OPERATION_STATE');
    }
    if (deliveryState === 'PUBLISHED') {
      if (state !== 'COMMITTED') {
        throw new ServiceUnavailableException('INVALID_DELIVERY_STATE');
      }

      return;
    }
    if (deliveryState !== 'PENDING') {
      throw new ServiceUnavailableException('INVALID_DELIVERY_STATE');
    }

    const shard = deliveryShard(
      message.chatId,
      message.senderDeviceId,
      message.seq,
    );

    await this.cassandra.client.execute(
      `INSERT INTO e2e_delivery_pending (
         shard,
         chat_id,
         sender_device_id,
         seq,
         message_id,
         message_hash
       )
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        shard,
        message.chatId,
        message.senderDeviceId,
        types.Long.fromNumber(message.seq),
        types.TimeUuid.fromString(operation.messageId),
        prepared.messageHash,
      ],
      WRITE_OPTIONS,
    );
  }
}
