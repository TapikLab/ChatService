import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '../../common/cassandra/cassandra.service';
import { ChatChainService } from '../messages/signing/chat-chain.service';
import { DeviceChainService } from '../messages/signing/device-chain.service';
import {
  buildSigningPayload,
  computeContentHash,
  computeMessageHash,
  verifyEd25519,
} from '../messages/signing/message-signature';
import { computeServerMessageHash } from '../messages/signing/chain-hash';
import {
  readCheckpoint,
  verifyCheckpoint,
} from '../messages/signing/checkpoint';
import {
  isServiceMessageType,
  parseAppendCommand,
  readMutation,
  type AppendCommand,
  type StoredMessage,
  type WriterAttachment,
} from './contract';
import { WriterDeviceKeysService } from './writer-device-keys.service';

const READ = { prepare: true, consistency: types.consistencies.localQuorum };
const CAS = { ...READ, serialConsistency: types.consistencies.localSerial };

interface DbAttachment {
  media_id: types.Uuid;
  type: string;
  url: string | null;
  file_name: string | null;
  size_bytes: number | null;
  placeholder: string | null;
}

@Injectable()
export class WriterStoreService implements OnModuleInit {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly devices: DeviceChainService,
    private readonly chain: ChatChainService,
    private readonly keys: WriterDeviceKeysService,
  ) {}

  async onModuleInit(): Promise<void> {
    const keyspace = this.cassandra.client.keyspace;
    for (const table of [
      'messages',
      'chat_chain_log',
      'chat_chain_claims',
      'device_chain_state',
    ]) {
      const result = await this.cassandra.client.execute(
        'SELECT default_time_to_live FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?',
        [keyspace, table],
        READ,
      );
      if (result.first()?.get('default_time_to_live') !== 0) {
        throw new Error(`NON_EXPIRING_TABLE_REQUIRED:${table}`);
      }
    }
  }

  async append(value: unknown): Promise<StoredMessage> {
    const command = parseAppendCommand(value);
    const { message: dto, senderId, signed } = command;
    const member = await this.cassandra.client.execute(
      'SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id = ?',
      [dto.chatId, senderId],
      READ,
    );
    if (!member.first()) throw new ForbiddenException('NOT_A_CHAT_MEMBER');

    let checkpoint: ReturnType<typeof readCheckpoint>;
    try {
      checkpoint = readCheckpoint(dto.content);
    } catch {
      throw new BadRequestException('INVALID_CHECKPOINT');
    }
    const mutation = readMutation(dto.content);
    if (
      (checkpoint || mutation) &&
      (!signed || command.viaAssistant || dto.attachments?.length)
    ) {
      throw new BadRequestException('INVALID_SERVICE_MESSAGE');
    }

    let signedHash: string | undefined;
    if (signed) {
      const publicKey = await this.keys.getKey(senderId, signed.senderDeviceId);
      if (!publicKey) throw new ForbiddenException('DEVICE_NOT_ACTIVE');
      const payload = buildSigningPayload({
        chatId: dto.chatId,
        senderDeviceId: signed.senderDeviceId,
        seq: signed.seq,
        prevHash: signed.prevHash,
        contentHash: computeContentHash(dto.content, dto.attachments),
      });
      if (!verifyEd25519(publicKey, payload, signed.signature)) {
        throw new ForbiddenException('INVALID_MESSAGE_SIGNATURE');
      }
      signedHash = computeMessageHash(payload);
      if (
        checkpoint &&
        (checkpoint.chatId !== dto.chatId ||
          checkpoint.userId !== senderId ||
          checkpoint.deviceId !== signed.senderDeviceId ||
          !verifyCheckpoint(checkpoint, publicKey))
      )
        throw new ForbiddenException('INVALID_CHECKPOINT_SIGNATURE');
    }

    if (mutation) {
      const target = await this.read(
        dto.chatId,
        types.TimeUuid.fromString(mutation.editOf),
      );
      if (!target) throw new NotFoundException('EDIT_TARGET_NOT_FOUND');
      if (String(target.get('sender_id')) !== senderId) {
        throw new ForbiddenException('EDIT_TARGET_NOT_OWNED');
      }
      if (
        isServiceMessageType(target.get('type')) ||
        target.get('via_assistant')
      ) {
        throw new BadRequestException('EDIT_TARGET_NOT_ORDINARY');
      }
    }

    const messageId =
      signed && signedHash
        ? await this.devices.claim({
            chatId: dto.chatId,
            deviceId: signed.senderDeviceId,
            seq: signed.seq,
            prevHash: signed.prevHash,
            messageHash: signedHash,
            signature: signed.signature,
          })
        : types.TimeUuid.fromString(command.messageId!);

    const messageHash =
      signedHash ??
      computeServerMessageHash({
        chatId: dto.chatId,
        messageId: messageId.toString(),
        senderId,
        contentHash: computeContentHash(dto.content, dto.attachments),
      });
    const type = checkpoint
      ? 'CHECKPOINT'
      : mutation
        ? mutation.type
        : dto.attachments?.length
          ? dto.content
            ? 'mixed'
            : dto.attachments[0].type
          : 'text';

    const existing = await this.read(dto.chatId, messageId);
    if (existing) return this.replay(existing, command, messageHash, type);

    const position = await this.chain.append({
      chatId: dto.chatId,
      messageId,
      messageHash,
      kind: signed ? 'signed' : 'server',
    });

    const attachments = (dto.attachments ?? []).map((a) => ({
      media_id: types.Uuid.fromString(a.mediaId),
      type: a.type,
      url: a.url ?? null,
      file_name: a.fileName ?? null,
      size_bytes: a.sizeBytes ?? null,
      placeholder: a.placeholder ?? null,
    }));

    const result = await this.cassandra.client.execute(
      `INSERT INTO messages
       (chat_id, message_id, sender_id, content, type, created_at, attachments,
        via_assistant, chat_seq, chain_hash, message_hash, sender_device_id,
        seq, prev_hash, signature, edit_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
      [
        dto.chatId,
        messageId,
        senderId,
        dto.content ?? null,
        type,
        messageId.getDate(),
        attachments,
        command.viaAssistant,
        types.Long.fromNumber(position.chatSeq),
        position.chainHash,
        messageHash,
        signed?.senderDeviceId ?? null,
        signed ? types.Long.fromNumber(signed.seq) : null,
        signed?.prevHash ?? null,
        signed?.signature ?? null,
        mutation ? types.TimeUuid.fromString(mutation.editOf) : null,
      ],
      CAS,
    );

    const stored = await this.read(dto.chatId, messageId);
    if (!stored) throw new ConflictException('MESSAGE_COMMIT_NOT_VISIBLE');
    const reply = this.replay(stored, command, messageHash, type);
    return { ...reply, replayed: !result.wasApplied() };
  }

  private async read(
    chatId: string,
    messageId: types.TimeUuid,
  ): Promise<types.Row | null> {
    const result = await this.cassandra.client.execute(
      'SELECT * FROM messages WHERE chat_id = ? AND message_id = ?',
      [chatId, messageId],
      READ,
    );
    return result.first() ?? null;
  }

  private replay(
    row: types.Row,
    command: AppendCommand,
    messageHash: string,
    type: string,
  ): StoredMessage {
    if (
      row.get('message_hash') !== messageHash ||
      String(row.get('sender_id')) !== command.senderId ||
      row.get('type') !== type ||
      Boolean(row.get('via_assistant')) !== command.viaAssistant ||
      (row.get('signature') ?? null) !== (command.signed?.signature ?? null)
    )
      throw new ConflictException('MESSAGE_ID_REUSED');

    const attachments: WriterAttachment[] = (
      (row.get('attachments') as DbAttachment[] | null) ?? []
    ).map((a) => ({
      mediaId: String(a.media_id),
      type: a.type,
      url: a.url ?? undefined,
      fileName: a.file_name ?? undefined,
      sizeBytes: a.size_bytes ?? undefined,
      placeholder: a.placeholder ?? undefined,
    }));
    return {
      chatId: String(row.get('chat_id')),
      messageId: String(row.get('message_id')),
      senderId: String(row.get('sender_id')),
      content: (row.get('content') as string | null) ?? undefined,
      attachments,
      type: row.get('type') as string,
      createdAt: (row.get('created_at') as Date).toISOString(),
      viaAssistant: Boolean(row.get('via_assistant')),
      chatSeq: (row.get('chat_seq') as types.Long).toNumber(),
      chainHash: row.get('chain_hash') as string,
      messageHash: row.get('message_hash') as string,
      editOf: row.get('edit_of') ? String(row.get('edit_of')) : null,
      senderDeviceId: row.get('sender_device_id')
        ? String(row.get('sender_device_id'))
        : null,
      seq: (row.get('seq') as types.Long | null)?.toNumber() ?? null,
      prevHash: (row.get('prev_hash') as string | null) ?? null,
      signature: (row.get('signature') as string | null) ?? null,
      replayed: true,
    };
  }
}
