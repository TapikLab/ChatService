import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CheckpointClient,
  rawPublicKey,
  type ClientIdentity,
  type Divergence,
  type Request,
  type SignedBody,
} from './client';
import {
  buildSigningPayload,
  computeContentHash,
  computeMessageHash,
  GENESIS_HASH,
} from '../../src/modules/messages/signing/message-signature';
import { computeChainHash } from '../../src/modules/messages/signing/chain-hash';
import {
  createCheckpoint,
  encodeCheckpoint,
  readCheckpoint,
  verifyCheckpoint,
} from '../../src/modules/messages/signing/checkpoint';

class FakeServer {
  readonly messages: Record<string, unknown>[] = [];
  readonly entries: Record<string, unknown>[] = [];
  readonly requests: SignedBody[] = [];
  failAfterCommit = false;
  private readonly accepted = new Map<
    string,
    { body: SignedBody; message: Record<string, unknown> }
  >();
  constructor(private readonly senderId: string) {}
  readonly request: Request = async (path, body) => {
    // Keep a scheduling boundary like the real HTTP transport.
    await Promise.resolve();
    if (body) {
      this.requests.push({ ...body });
      const id = `${body.senderDeviceId}:${body.seq}`;
      const existing = this.accepted.get(id);
      if (existing) {
        if (JSON.stringify(existing.body) !== JSON.stringify(body))
          throw new Error('SEQ_REUSED');
        return existing.message;
      }
      const payload = buildSigningPayload({
        ...body,
        contentHash: computeContentHash(body.content, undefined),
      });
      const messageHash = computeMessageHash(payload);
      const chatSeq = this.entries.length + 1;
      const previous = this.entries[this.entries.length - 1];
      const chainHash = computeChainHash(
        chatSeq,
        previous ? String(previous.chainHash) : GENESIS_HASH,
        messageHash,
      );
      const messageId = randomUUID();
      const message = {
        ...body,
        senderId: this.senderId,
        messageId,
        chatSeq,
        chainHash,
        messageHash,
        attachments: [],
        type: readCheckpoint(body.content) ? 'CHECKPOINT' : 'text',
      };
      this.messages.push(message);
      this.entries.push({
        chatSeq,
        messageId,
        messageHash,
        chainHash,
        kind: 'signed',
      });
      this.accepted.set(id, { body: { ...body }, message });
      if (this.failAfterCommit) {
        this.failAfterCommit = false;
        throw new Error('NETWORK_LOST_AFTER_COMMIT');
      }
      return message;
    }
    const url = new URL(path, 'http://test');
    const before = url.searchParams.get('before');
    const limit = Number(url.searchParams.get('limit'));
    if (url.pathname.endsWith('/chain'))
      return {
        entries: [...this.entries]
          .reverse()
          .filter(
            (entry) =>
              before === null || Number(entry.chatSeq) < Number(before),
          )
          .slice(0, limit),
      };
    const newest = [...this.messages].reverse();
    const start =
      before === null
        ? 0
        : newest.findIndex((message) => message.messageId === before) + 1;
    return newest.slice(start, start + limit);
  };
}

describe('checkpoint client', () => {
  let directory: string;
  let identity: ClientIdentity;
  let peer: ClientIdentity;
  let server: FakeServer;
  let client: CheckpointClient;
  let events: Divergence[];
  let now: number;
  const open = (request = server.request): CheckpointClient =>
    new CheckpointClient(
      identity,
      join(directory, 'state.jsonl'),
      request,
      (event) => events.push(event),
      () => now,
    );
  const checkpoint = (
    seq: number,
    chainHash: string,
    chatId = identity.chatId,
  ): string =>
    encodeCheckpoint(
      createCheckpoint(
        {
          chatId,
          chatSeq: seq,
          chainHash,
          userId: peer.userId,
          deviceId: peer.deviceId,
        },
        peer.privateKey,
      ),
    );
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tapik-checkpoint-'));
    events = [];
    now = 1_000_000;
    identity = {
      chatId: randomUUID(),
      userId: randomUUID(),
      deviceId: randomUUID(),
      privateKey: generateKeyPairSync('ed25519').privateKey,
      pins: [],
    };
    peer = {
      ...identity,
      userId: randomUUID(),
      deviceId: randomUUID(),
      privateKey: generateKeyPairSync('ed25519').privateKey,
    };
    identity.pins = [identity, peer].map((item) => ({
      userId: item.userId,
      deviceId: item.deviceId,
      publicKey: rawPublicKey(item.privateKey),
    }));
    server = new FakeServer(identity.userId);
    client = open();
  });
  afterEach(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('accepts matching witnesses; duplicate delivery does not grow the journal', async () => {
    await client.sendText('hello');
    await client.sync();
    const content = checkpoint(1, String(server.entries[0].chainHash));
    await client.observeCheckpoint(content);
    const before = readFileSync(join(directory, 'state.jsonl'), 'utf8');
    await client.observeCheckpoint(content);
    expect(readFileSync(join(directory, 'state.jsonl'), 'utf8')).toBe(before);
    expect(events).toHaveLength(0);
  });
  it('reports verifiable signed evidence and blocks sending on divergence', async () => {
    await client.sendText('hello');
    await client.sync();
    await client.observeCheckpoint(checkpoint(1, 'f'.repeat(64)));
    expect(events).toHaveLength(1);
    expect(
      verifyCheckpoint(events[0].left, rawPublicKey(identity.privateKey)),
    ).toBe(true);
    expect(
      verifyCheckpoint(events[0].right, rawPublicKey(peer.privateKey)),
    ).toBe(true);
    await expect(client.sendText('blocked')).rejects.toThrow(
      'CHAT_HISTORY_DIVERGENCE',
    );
  });
  it('retains early witnesses until the local position is verified', async () => {
    await client.observeCheckpoint(checkpoint(1, 'e'.repeat(64)));
    expect(events).toHaveLength(0);
    await client.sendText('hello');
    await expect(client.sync()).rejects.toThrow('CHAT_HISTORY_DIVERGENCE');
    expect(events).toHaveLength(1);
  });
  it('compares witnesses at the same position before history arrives', async () => {
    await client.observeCheckpoint(checkpoint(50, 'a'.repeat(64)));
    await client.observeCheckpoint(checkpoint(51, 'b'.repeat(64)));
    expect(events).toHaveLength(0);
    await client.observeCheckpoint(checkpoint(50, 'b'.repeat(64)));
    expect(events[0].chatSeq).toBe(50);
  });
  it('rejects altered hashes, signatures, other chats and unknown devices', async () => {
    const cp = readCheckpoint(checkpoint(1, 'a'.repeat(64)));
    if (!cp) throw new Error('TEST_CHECKPOINT_REQUIRED');
    await expect(
      client.observeCheckpoint(
        encodeCheckpoint({ ...cp, chainHash: 'b'.repeat(64) }),
      ),
    ).rejects.toThrow('INVALID_CHECKPOINT_SIGNATURE');
    await expect(
      client.observeCheckpoint(
        encodeCheckpoint({
          ...cp,
          signature: Buffer.alloc(64).toString('base64'),
        }),
      ),
    ).rejects.toThrow('INVALID_CHECKPOINT_SIGNATURE');
    await expect(
      client.observeCheckpoint(checkpoint(1, 'a'.repeat(64), randomUUID())),
    ).rejects.toThrow('CHECKPOINT_CHAT_MISMATCH');
    await expect(
      client.observeCheckpoint(
        encodeCheckpoint({ ...cp, deviceId: randomUUID() }),
      ),
    ).rejects.toThrow('UNTRUSTED_DEVICE');
  });
  it('retries the exact persisted body after lost ACK and restart', async () => {
    server.failAfterCommit = true;
    await expect(client.sendText('once')).rejects.toThrow(
      'NETWORK_LOST_AFTER_COMMIT',
    );
    await client.close();
    client = open();
    await client.sync();
    expect(server.messages).toHaveLength(1);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]).toEqual(server.requests[0]);
    expect(client.status).toMatchObject({
      sentSeq: 1,
      pending: false,
      head: 1,
    });
  });
  it('publishes after 50 verified ordinary messages, never loops on checkpoints', async () => {
    for (let i = 0; i < 50; i++) await client.sendText(`message-${i}`);
    await client.sync();
    await client.tick();
    expect(server.messages).toHaveLength(51);
    expect(server.messages[50].type).toBe('CHECKPOINT');
    await client.sync();
    now += 600_000;
    await client.tick();
    expect(server.messages).toHaveLength(51);
    expect(client.status).toMatchObject({
      ordinaryCount: 50,
      publishedCount: 50,
    });
  });
  it('serializes timer, retries and ordinary sends on one device chain', async () => {
    await client.sendText('first');
    await client.sync();
    now += 299_999;
    await client.tick();
    expect(server.messages).toHaveLength(1);
    now++;
    await Promise.all([client.tick(), client.sendText('second')]);
    expect(server.requests.map((body) => body.seq)).toEqual([1, 2, 3]);
    expect(server.messages[1].type).toBe('CHECKPOINT');
    await client.sync();
    expect(client.status.ordinaryCount).toBe(2);
  });
  it('restores the checkpoint timer and a pending checkpoint after restart', async () => {
    await client.sendText('first');
    await client.sync();
    await client.close();
    now += 300_000;
    client = open();
    server.failAfterCommit = true;
    await expect(client.tick()).rejects.toThrow('NETWORK_LOST_AFTER_COMMIT');
    await client.close();
    client = open();
    await client.tick();
    expect(server.messages).toHaveLength(2);
    expect(server.requests[2]).toEqual(server.requests[1]);
    expect(client.status.publishedCount).toBe(1);
  });
  it('retains pending comparisons and established divergences across restart', async () => {
    await client.observeCheckpoint(checkpoint(1, 'd'.repeat(64)));
    await client.close();
    client = open();
    await client.sendText('hello');
    await expect(client.sync()).rejects.toThrow('CHAT_HISTORY_DIVERGENCE');
    await client.close();
    events = [];
    client = open();
    expect(events).toHaveLength(1);
    expect(client.status.blocked).toBe(true);
  });
  it('recovers an incomplete final journal record without losing the outbox', async () => {
    server.failAfterCommit = true;
    await expect(client.sendText('once')).rejects.toThrow();
    await client.close();
    appendFileSync(join(directory, 'state.jsonl'), '{"kind":"sent"');
    client = open();
    await client.sync();
    expect(server.messages).toHaveLength(1);
    expect(client.status.pending).toBe(false);
  });
  it('rejects another writer and releases the lock on clean shutdown', async () => {
    expect(() => open()).toThrow();
    await client.close();
    expect(existsSync(join(directory, 'state.jsonl.lock'))).toBe(false);
    client = open();
  });
  it('fails closed on a malformed complete journal record', async () => {
    await client.close();
    appendFileSync(join(directory, 'state.jsonl'), '{broken}\n');
    expect(() => open()).toThrow();
    expect(existsSync(join(directory, 'state.jsonl.lock'))).toBe(false);
  });
  it('fails closed on a changed pinned key after restart', async () => {
    await client.observeCheckpoint(checkpoint(1, 'd'.repeat(64)));
    await client.close();
    const changedKey = rawPublicKey(generateKeyPairSync('ed25519').privateKey);
    identity.pins = identity.pins.map((pin) =>
      pin.deviceId === peer.deviceId ? { ...pin, publicKey: changedKey } : pin,
    );
    expect(() => open()).toThrow('INVALID_CHECKPOINT_SIGNATURE');
  });
  it('detects a rollback or modified persisted head', async () => {
    await client.sendText('one');
    await client.sync();
    server.entries[0].chainHash = 'f'.repeat(64);
    await expect(client.sync()).rejects.toThrow('CHAIN_ROLLBACK_OR_FORK');
    server.entries.length = 0;
    await expect(client.sync()).rejects.toThrow('CHAIN_ANCHOR_MISSING');
  });
  it('rejects a modified message before advancing the verified head', async () => {
    await client.sendText('one');
    server.messages[0].content = 'tampered';
    await expect(client.sync()).rejects.toThrow('INVALID_MESSAGE_SIGNATURE');
    expect(client.status.head).toBe(0);
  });
  it('recovers missing realtime delivery through paginated history', async () => {
    for (let i = 0; i < 101; i++) await client.sendText(`message-${i}`);
    await client.sync();
    expect(client.status.head).toBe(101);
    await client.tick();
    await client.sync();
    expect(client.status).toMatchObject({ head: 102, ordinaryCount: 101 });
  });
  it('keeps outbox pending on a malformed ACK', async () => {
    await client.close();
    client = open(async (path, body) => {
      const result = await server.request(path, body);
      return body ? { chatId: identity.chatId, content: 'wrong' } : result;
    });
    await expect(client.sendText('hello')).rejects.toThrow('INVALID_SEND_ACK');
    expect(client.status).toMatchObject({ pending: true, sentSeq: 0 });
  });
});
