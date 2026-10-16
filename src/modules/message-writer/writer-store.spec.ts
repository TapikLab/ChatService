import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { types } from 'cassandra-driver';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatChainService } from '../messages/signing/chat-chain.service';
import { DeviceChainService } from '../messages/signing/device-chain.service';
import {
  buildSigningPayload,
  computeContentHash,
} from '../messages/signing/message-signature';
import {
  createCheckpoint,
  encodeCheckpoint,
} from '../messages/signing/checkpoint';
import {
  MUTATION_PREFIX,
  parseAppendCommand,
  type AppendCommand,
} from './contract';
import { WriterStoreService } from './writer-store.service';
import { WriterDeviceKeysService } from './writer-device-keys.service';

function row(value: Record<string, unknown>): types.Row {
  return { get: (key: string) => value[key] } as unknown as types.Row;
}
function result(value: types.Row | null, applied = false) {
  return {
    first: () => value,
    wasApplied: () => applied,
    rowLength: value ? 1 : 0,
  };
}

describe('immutable writer', () => {
  let module: TestingModule;
  let store: WriterStoreService;
  let command: AppendCommand;
  let messages: Map<string, Record<string, unknown>>;
  let queries: string[];
  let claims: Map<string, types.TimeUuid>;
  let member: boolean;
  let deniedKey: boolean;
  let failAfterInsert: boolean;
  let tableTtl: number;
  const keypair = generateKeyPairSync('ed25519');
  const publicKey = keypair.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');

  function signed(content: string, seq = 1): AppendCommand {
    const proof = {
      senderDeviceId: command.signed!.senderDeviceId,
      seq,
      prevHash: '0'.repeat(64),
      signature: '',
    };
    proof.signature = sign(
      null,
      Buffer.from(
        buildSigningPayload({
          chatId: command.message.chatId,
          senderDeviceId: proof.senderDeviceId,
          seq,
          prevHash: proof.prevHash,
          contentHash: computeContentHash(content, undefined),
        }),
      ),
      keypair.privateKey,
    ).toString('base64');
    return {
      version: 1,
      senderId: command.senderId,
      viaAssistant: false,
      message: { chatId: command.message.chatId, content },
      signed: proof,
    };
  }

  beforeEach(async () => {
    messages = new Map();
    queries = [];
    claims = new Map();
    member = true;
    deniedKey = false;
    failAfterInsert = false;
    tableTtl = 0;
    command = {
      version: 1,
      senderId: randomUUID(),
      viaAssistant: false,
      message: { chatId: randomUUID(), content: 'hello' },
      signed: {
        senderDeviceId: randomUUID(),
        seq: 1,
        prevHash: '0'.repeat(64),
        signature: '',
      },
    };
    command = signed('hello');
    const execute = async (query: string, params: unknown[]) => {
      queries.push(query);
      if (query.includes('FROM system_schema.tables'))
        return result(row({ default_time_to_live: tableTtl }));
      if (query.includes('FROM chat_members'))
        return result(member ? row({ user_id: command.senderId }) : null);
      if (query.startsWith('SELECT * FROM messages')) {
        const value = messages.get(String(params[1]));
        return result(value ? row(value) : null);
      }
      if (query.startsWith('INSERT INTO messages')) {
        expect(query).toMatch(/IF NOT EXISTS$/);
        expect(query).not.toMatch(/\bTTL\b|\bTIMESTAMP\b/);
        const columns = [
          'chat_id',
          'message_id',
          'sender_id',
          'content',
          'type',
          'created_at',
          'attachments',
          'via_assistant',
          'chat_seq',
          'chain_hash',
          'message_hash',
          'sender_device_id',
          'seq',
          'prev_hash',
          'signature',
          'edit_of',
        ];
        const id = String(params[1]);
        if (messages.has(id)) return result(row(messages.get(id)!), false);
        messages.set(
          id,
          Object.fromEntries(
            columns.map((column, index) => [column, params[index]]),
          ),
        );
        if (failAfterInsert) {
          failAfterInsert = false;
          throw new Error('CONNECTION_LOST');
        }
        return result(null, true);
      }
      throw new Error(`Unexpected query: ${query}`);
    };
    module = await Test.createTestingModule({
      providers: [
        WriterStoreService,
        {
          provide: CassandraService,
          useValue: { client: { execute, keyspace: 'chat_alpha_messages' } },
        },
        {
          provide: WriterDeviceKeysService,
          useValue: { getKey: async () => (deniedKey ? null : publicKey) },
        },
        {
          provide: DeviceChainService,
          useValue: {
            claim: async (input: { signature: string }) => {
              let id = claims.get(input.signature);
              if (!id) {
                id = types.TimeUuid.now();
                claims.set(input.signature, id);
              }
              return id;
            },
          },
        },
        {
          provide: ChatChainService,
          useValue: {
            append: async () => ({
              chatSeq: messages.size + 1,
              chainHash: 'a'.repeat(64),
            }),
          },
        },
      ],
    }).compile();
    store = module.get(WriterStoreService);
  });
  afterEach(async () => {
    await module.close();
  });

  it('inserts signed records once and returns the stored record on replay', async () => {
    const first = await store.append(command);
    const again = await store.append(command);
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ ...first, replayed: true });
    expect(messages.size).toBe(1);
    expect(queries.filter((q) => q.startsWith('INSERT'))).toHaveLength(1);
  });

  it('refuses expiring protected tables at startup', async () => {
    tableTtl = 60;
    await expect(store.onModuleInit()).rejects.toThrow(
      'NON_EXPIRING_TABLE_REQUIRED',
    );
    expect(messages.size).toBe(0);
  });

  it('checks all four protected tables at startup', async () => {
    await store.onModuleInit();
    expect(
      queries.filter((q) => q.includes('FROM system_schema.tables')),
    ).toHaveLength(4);
  });

  it('handles concurrent identical sends without overwriting a row', async () => {
    const replies = await Promise.all([
      store.append(command),
      store.append(command),
    ]);
    expect(messages.size).toBe(1);
    expect(replies[0].messageId).toBe(replies[1].messageId);
    expect(replies.filter((reply) => !reply.replayed)).toHaveLength(1);
  });

  it('retries an ambiguous committed write without overwriting it', async () => {
    failAfterInsert = true;
    await expect(store.append(command)).rejects.toThrow('CONNECTION_LOST');
    const recovered = await store.append(command);
    expect(recovered.replayed).toBe(true);
    expect(messages.size).toBe(1);
    expect(queries.filter((q) => q.startsWith('INSERT'))).toHaveLength(1);
  });

  it('protects unsigned server records against identifier reuse', async () => {
    const plain: AppendCommand = {
      version: 1,
      senderId: command.senderId,
      viaAssistant: true,
      message: command.message,
      messageId: types.TimeUuid.now().toString(),
    };
    await store.append(plain);
    await expect(
      store.append({
        ...plain,
        message: { ...plain.message, content: 'replacement' },
      }),
    ).rejects.toThrow('MESSAGE_ID_REUSED');
    expect(messages.get(plain.messageId!)?.content).toBe('hello');
  });

  it.each(['signature', 'content'] as const)(
    'rejects a modified %s before any write',
    async (field) => {
      const invalid = structuredClone(command);
      if (field === 'signature')
        invalid.signed!.signature = Buffer.alloc(64).toString('base64');
      else invalid.message.content = 'tampered';
      await expect(store.append(invalid)).rejects.toThrow(
        'INVALID_MESSAGE_SIGNATURE',
      );
      expect(messages.size).toBe(0);
      expect(claims.size).toBe(0);
    },
  );

  it('rejects an inactive device', async () => {
    deniedKey = true;
    await expect(store.append(command)).rejects.toThrow('DEVICE_NOT_ACTIVE');
    expect(claims.size).toBe(0);
  });

  it('rejects a non-member before claiming a chain position', async () => {
    member = false;
    await expect(store.append(command)).rejects.toThrow('NOT_A_CHAT_MEMBER');
    expect(claims.size).toBe(0);
  });

  it('appends EDIT and DELETE while preserving the original row', async () => {
    const original = await store.append(command);
    const originalRow = JSON.stringify(messages.get(original.messageId));
    const edit = await store.append(
      signed(
        MUTATION_PREFIX +
          JSON.stringify([1, 'EDIT', original.messageId, 'new text']),
        2,
      ),
    );
    const deletion = await store.append(
      signed(
        MUTATION_PREFIX + JSON.stringify([1, 'DELETE', original.messageId]),
        3,
      ),
    );
    expect(edit).toMatchObject({ type: 'EDIT', editOf: original.messageId });
    expect(deletion).toMatchObject({
      type: 'DELETE',
      editOf: original.messageId,
    });
    expect(JSON.stringify(messages.get(original.messageId))).toBe(originalRow);
    expect(messages.size).toBe(3);
    expect(queries.some((q) => /^(UPDATE|DELETE|TRUNCATE)/.test(q))).toBe(
      false,
    );
  });

  it('rejects editing another sender record', async () => {
    const original = await store.append(command);
    messages.get(original.messageId)!.sender_id = randomUUID();
    await expect(
      store.append(
        signed(
          MUTATION_PREFIX + JSON.stringify([1, 'DELETE', original.messageId]),
          2,
        ),
      ),
    ).rejects.toThrow('EDIT_TARGET_NOT_OWNED');
    expect(messages.size).toBe(1);
  });

  it('rejects a missing edit target', async () => {
    await expect(
      store.append(
        signed(
          MUTATION_PREFIX +
            JSON.stringify([1, 'DELETE', types.TimeUuid.now().toString()]),
        ),
      ),
    ).rejects.toThrow('EDIT_TARGET_NOT_FOUND');
    expect(messages.size).toBe(0);
  });

  it('rejects edits of service events', async () => {
    const original = await store.append(command);
    messages.get(original.messageId)!.type = 'CHECKPOINT';
    await expect(
      store.append(
        signed(
          MUTATION_PREFIX +
            JSON.stringify([1, 'EDIT', original.messageId, 'new']),
          2,
        ),
      ),
    ).rejects.toThrow('EDIT_TARGET_NOT_ORDINARY');
  });

  it('retains checkpoint signature validation at the trusted boundary', async () => {
    const checkpoint = createCheckpoint(
      {
        chatId: command.message.chatId,
        chatSeq: 1,
        chainHash: 'b'.repeat(64),
        userId: command.senderId,
        deviceId: command.signed!.senderDeviceId,
      },
      keypair.privateKey,
    );
    const saved = await store.append(signed(encodeCheckpoint(checkpoint)));
    expect(saved.type).toBe('CHECKPOINT');
    const forged = { ...checkpoint, chainHash: 'c'.repeat(64) };
    await expect(
      store.append(signed(encodeCheckpoint(forged), 2)),
    ).rejects.toThrow('INVALID_CHECKPOINT_SIGNATURE');
    expect(messages.size).toBe(1);
  });

  it.each(['query', 'ttl', 'timestamp', 'editOf', 'chainHash', 'table'])(
    'rejects caller-controlled %s',
    async (field) => {
      await expect(
        store.append({ ...command, [field]: 'injected' }),
      ).rejects.toThrow('INVALID_APPEND_COMMAND');
      expect(queries).toHaveLength(0);
    },
  );

  it('rejects unsigned mutations and unsigned checkpoints', async () => {
    const content =
      MUTATION_PREFIX +
      JSON.stringify([1, 'DELETE', types.TimeUuid.now().toString()]);
    await expect(
      store.append({
        ...command,
        signed: undefined,
        messageId: types.TimeUuid.now().toString(),
        message: { ...command.message, content },
      }),
    ).rejects.toThrow('INVALID_SERVICE_MESSAGE');
  });

  it('does not accept a caller-selected id for a signed message', () => {
    expect(() =>
      parseAppendCommand({
        ...command,
        messageId: types.TimeUuid.now().toString(),
      }),
    ).toThrow();
  });
});
