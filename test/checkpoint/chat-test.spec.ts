import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSender, type SenderConfig } from './chat-test';
import { object, string } from './client';
import {
  buildSigningPayload,
  computeContentHash,
  computeMessageHash,
  GENESIS_HASH,
  verifyEd25519,
} from '../../src/modules/messages/signing/message-signature';

class HttpFixture {
  readonly users = new Map<string, string>();
  readonly keys = new Map<string, string>();
  readonly deviceIds = new Map<string, string>();
  readonly requests: Record<string, unknown>[] = [];
  readonly accepted = new Map<
    string,
    { body: string; response: Record<string, unknown> }
  >();
  readonly heads = new Map<string, { seq: number; hash: string }>();
  loseAck = false;

  readonly fetch: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body =
      init?.body === undefined
        ? null
        : object(JSON.parse(string(init.body)) as unknown);
    const headers = new Headers(init?.headers);
    const email = headers.get('Authorization')?.replace('Bearer token:', '');
    const userId = email ? this.users.get(email) : undefined;
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });
    if (url.pathname === '/auth/login' && body) {
      const loginEmail = string(body.email);
      if (!this.users.has(loginEmail)) this.users.set(loginEmail, randomUUID());
      return reply({ accessToken: `token:${loginEmail}` });
    }
    if (!userId) return reply({}, 401);
    if (url.pathname === '/auth/profile') return reply({ userId });
    if (url.pathname === '/auth/devices' && body) {
      const publicKey = string(body.publicKey);
      const keyId = `${userId}:${publicKey}`;
      let deviceId = this.deviceIds.get(keyId);
      if (!deviceId) {
        deviceId = randomUUID();
        this.deviceIds.set(keyId, deviceId);
      }
      this.keys.set(deviceId, publicKey);
      return reply({ deviceId, publicKey });
    }
    if (url.pathname !== '/chats/messages' || !body) return reply({}, 404);
    this.requests.push(body);
    const deviceId = string(body.senderDeviceId);
    const publicKey = this.keys.get(deviceId);
    if (!publicKey || !this.deviceIds.has(`${userId}:${publicKey}`))
      return reply({}, 403);
    if (typeof body.seq !== 'number') throw new Error('SEQ_NOT_NUMERIC');
    const payload = buildSigningPayload({
      chatId: string(body.chatId),
      senderDeviceId: deviceId,
      seq: body.seq,
      prevHash: string(body.prevHash),
      contentHash: computeContentHash(string(body.content), undefined),
    });
    if (!verifyEd25519(publicKey, payload, string(body.signature)))
      return reply({}, 403);
    const deviceChat = `${String(body.chatId)}:${deviceId}`;
    const requestId = `${deviceChat}:${body.seq}`;
    const encoded = JSON.stringify(body);
    const previous = this.accepted.get(requestId);
    if (previous) {
      if (previous.body !== encoded) return reply({}, 409);
      return reply(previous.response);
    }
    const head = this.heads.get(deviceChat);
    if (
      body.seq !== (head?.seq ?? 0) + 1 ||
      body.prevHash !== (head?.hash ?? GENESIS_HASH)
    )
      return reply({}, 409);
    const response = {
      chatId: body.chatId,
      messageId: randomUUID(),
      content: body.content,
    };
    this.accepted.set(requestId, { body: encoded, response });
    this.heads.set(deviceChat, {
      seq: body.seq,
      hash: computeMessageHash(payload),
    });
    if (this.loseAck) {
      this.loseAck = false;
      throw new Error('ACK_LOST');
    }
    return reply(response);
  };
}

describe('universal chat sender', () => {
  let directory: string;
  let fixture: HttpFixture;
  let config: SenderConfig;
  const sessions: Awaited<ReturnType<typeof prepareSender>>[] = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tapik-chat-test-'));
    fixture = new HttpFixture();
    config = {
      name: 'Alice',
      email: 'alice@example.com',
      password: 'test-only',
      chatId: randomUUID(),
      authUrl: 'http://test/auth',
      chatUrl: 'http://test',
      stateDir: join(directory, 'alice'),
    };
  });
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = async (settings = config) => {
    const session = await prepareSender(settings, fixture.fetch);
    sessions.push(session);
    return session;
  };
  it('logs in and registers two separate devices that send to one chat', async () => {
    const alice = await open();
    const bob = await open({
      ...config,
      name: 'Bob',
      email: 'bob@example.com',
      stateDir: join(directory, 'bob'),
    });
    await Promise.all([
      alice.client.sendText('Hello Bob'),
      bob.client.sendText('Hello Alice'),
    ]);
    expect(alice.pin.deviceId).not.toBe(bob.pin.deviceId);
    expect(alice.pin.publicKey).not.toBe(bob.pin.publicKey);
    expect(fixture.requests.map((request) => request.chatId)).toEqual([
      config.chatId,
      config.chatId,
    ]);
    expect(fixture.requests.map((request) => request.seq)).toEqual([1, 1]);
  });
  it('retains the registered key and continues seq/prevHash after restart', async () => {
    const first = await open();
    await first.client.sendText('one');
    await first.client.close();
    const second = await open();
    await second.client.sendText('two');
    expect(second.pin).toEqual(first.pin);
    expect(fixture.requests.map((request) => request.seq)).toEqual([1, 2]);
    expect(fixture.requests[1].prevHash).not.toBe(GENESIS_HASH);
  });
  it('retries a committed request after lost ACK without creating another message', async () => {
    const first = await open();
    fixture.loseAck = true;
    await expect(first.client.sendText('once')).rejects.toThrow('ACK_LOST');
    await first.client.close();
    const second = await open();
    await second.client.retryPending();
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
    expect(fixture.accepted.size).toBe(1);
    expect(second.client.status).toMatchObject({ sentSeq: 1, pending: false });
  });
  it('refuses to reuse another account’s state directory', async () => {
    const alice = await open();
    await alice.client.close();
    await expect(
      prepareSender({ ...config, email: 'bob@example.com' }, fixture.fetch),
    ).rejects.toThrow('STATE_BELONGS_TO_ANOTHER_USER');
    expect(fixture.deviceIds.size).toBe(1);
  });
});
