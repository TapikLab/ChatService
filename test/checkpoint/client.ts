import { createPublicKey, sign, type KeyObject } from 'node:crypto';
import {
  buildSigningPayload,
  computeContentHash,
  computeMessageHash,
  GENESIS_HASH,
  verifyEd25519,
} from '../../src/modules/messages/signing/message-signature';
import {
  computeChainHash,
  computeServerMessageHash,
} from '../../src/modules/messages/signing/chain-hash';
import {
  CHECKPOINT_PREFIX,
  createCheckpoint,
  encodeCheckpoint,
  readCheckpoint,
  verifyCheckpoint,
  type Checkpoint,
} from '../../src/modules/messages/signing/checkpoint';
import { Journal } from './journal';

export interface Pin {
  userId: string;
  deviceId: string;
  publicKey: string;
}
export interface ClientIdentity {
  chatId: string;
  userId: string;
  deviceId: string;
  privateKey: KeyObject;
  pins: readonly Pin[];
}
export interface SignedBody {
  chatId: string;
  senderDeviceId: string;
  seq: number;
  prevHash: string;
  content: string;
  signature: string;
}
export interface Divergence {
  code: 'CHAT_HISTORY_DIVERGENCE';
  chatId: string;
  chatSeq: number;
  left: Checkpoint;
  right: Checkpoint;
}
export type Request = (path: string, body?: SignedBody) => Promise<unknown>;
interface Entry {
  chatSeq: number;
  messageId: string;
  messageHash: string;
  chainHash: string;
  kind: 'signed' | 'server';
}
interface Pending {
  body: SignedBody;
  messageHash: string;
  checkpointCount: number | null;
}
type Event =
  | { kind: 'verified'; entry: Entry; ordinary: boolean; at: number }
  | { kind: 'witness'; content: string }
  | { kind: 'pending'; pending: Pending }
  | { kind: 'sent' };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9+/]{43}=$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_OBJECT');
  }
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_STRING');
  return value;
}
export function uuid(value: unknown): string {
  const text = string(value);
  if (!UUID.test(text)) throw new Error('INVALID_UUID');
  return text;
}
function hash(value: unknown): string {
  const text = string(value);
  if (!HASH.test(text)) throw new Error('INVALID_HASH');
  return text;
}
function integer(value: unknown, minimum = 1): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error('INVALID_INTEGER');
  }
  return value;
}
function array(value: unknown, maximum = Infinity): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error('INVALID_ARRAY');
  return value as unknown[];
}
function entryFrom(value: unknown): Entry {
  const row = object(value);
  if (row.kind !== 'signed' && row.kind !== 'server')
    throw new Error('INVALID_CHAIN_KIND');
  return {
    chatSeq: integer(row.chatSeq),
    messageId: uuid(row.messageId),
    messageHash: hash(row.messageHash),
    chainHash: hash(row.chainHash),
    kind: row.kind,
  };
}
function signingPayload(body: SignedBody): string {
  return buildSigningPayload({
    ...body,
    contentHash: computeContentHash(body.content, undefined),
  });
}
export function rawPublicKey(privateKey: KeyObject): string {
  if (
    privateKey.type !== 'private' ||
    privateKey.asymmetricKeyType !== 'ed25519'
  ) {
    throw new Error('ED25519_PRIVATE_KEY_REQUIRED');
  }
  return createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
}

export class CheckpointClient {
  private readonly journal: Journal;
  private readonly pins = new Map<string, string>();
  private readonly positions = new Map<number, string>();
  private readonly messageIds = new Set<string>();
  private readonly witnesses = new Set<string>();
  private readonly bySequence = new Map<number, Map<string, Checkpoint>>();
  private readonly reported = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private head = 0;
  private sentSeq = 0;
  private sentHash = GENESIS_HASH;
  private ordinaryCount = 0;
  private publishedCount = 0;
  private dirtySince = 0;
  private pending: Pending | null = null;
  private blocked = false;
  private closed = false;

  constructor(
    private readonly identity: ClientIdentity,
    journalPath: string,
    private readonly request: Request,
    private readonly onDivergence: (event: Divergence) => void,
    private readonly now: () => number = Date.now,
  ) {
    uuid(identity.chatId);
    uuid(identity.userId);
    uuid(identity.deviceId);
    const publicKey = rawPublicKey(identity.privateKey);
    for (const pin of identity.pins) {
      const id = `${uuid(pin.userId)}:${uuid(pin.deviceId)}`;
      if (
        !KEY.test(pin.publicKey) ||
        Buffer.from(pin.publicKey, 'base64').toString('base64') !==
          pin.publicKey
      ) {
        throw new Error('INVALID_PIN');
      }
      if (this.pins.has(id) && this.pins.get(id) !== pin.publicKey)
        throw new Error('CONFLICTING_PIN');
      this.pins.set(id, pin.publicKey);
    }
    if (this.pin(identity.userId, identity.deviceId) !== publicKey)
      throw new Error('OWN_PIN_MISMATCH');
    this.journal = new Journal(journalPath);
    try {
      const header = {
        kind: 'identity',
        chatId: identity.chatId,
        userId: identity.userId,
        deviceId: identity.deviceId,
        publicKey,
      };
      if (this.journal.records.length === 0) this.journal.append(header);
      else {
        if (JSON.stringify(this.journal.records[0]) !== JSON.stringify(header))
          throw new Error('JOURNAL_IDENTITY_MISMATCH');
        for (const record of this.journal.records.slice(1))
          this.apply(this.eventFrom(record));
      }
      for (const seq of this.bySequence.keys()) this.checkPosition(seq);
    } catch (error) {
      this.journal.close();
      throw error;
    }
  }

  get status() {
    return {
      head: this.head,
      sentSeq: this.sentSeq,
      ordinaryCount: this.ordinaryCount,
      publishedCount: this.publishedCount,
      pending: this.pending !== null,
      blocked: this.blocked,
    };
  }

  sendText(content: string): Promise<void> {
    return this.serial(async () => {
      this.assertHealthy();
      if (
        !content ||
        content.length > 4000 ||
        content.startsWith(CHECKPOINT_PREFIX)
      )
        throw new Error('INVALID_TEXT');
      await this.flush();
      this.stage(content, null);
      await this.flush();
    });
  }

  observeCheckpoint(content: string): Promise<void> {
    return this.serial(() => {
      if (this.closed) throw new Error('CLIENT_CLOSED');
      this.receive(content);
    });
  }

  sync(): Promise<void> {
    return this.serial(async () => {
      this.assertHealthy();
      await this.flush();
      const entries = await this.loadEntries();
      if (!entries.length) return;
      const messages = await this.loadMessages(entries);
      this.assertHealthy();
      for (const entry of entries) {
        this.validateNext(entry);
        const message = messages.get(entry.messageId);
        if (!message) throw new Error('MESSAGE_NOT_AVAILABLE');
        const ordinary = this.verifyMessage(message, entry);
        this.assertHealthy();
        this.commit({ kind: 'verified', entry, ordinary, at: this.now() });
        this.checkPosition(entry.chatSeq);
        this.assertHealthy();
      }
    });
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      this.assertHealthy();
      await this.flush();
      const unpublished = this.ordinaryCount - this.publishedCount;
      if (
        !unpublished ||
        (unpublished < 50 && this.now() - this.dirtySince < 300_000)
      )
        return;
      const chainHash = this.positions.get(this.head);
      if (!chainHash) throw new Error('VERIFIED_POSITION_REQUIRED');
      const content = encodeCheckpoint(this.ownWitness(this.head, chainHash));
      this.receive(content);
      this.assertHealthy();
      this.stage(content, this.ordinaryCount);
      await this.flush();
    });
  }

  close(): Promise<void> {
    return this.serial(() => {
      if (this.closed) return;
      this.closed = true;
      this.journal.close();
    });
  }

  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private assertHealthy(): void {
    if (this.closed) throw new Error('CLIENT_CLOSED');
    if (this.blocked) throw new Error('CHAT_HISTORY_DIVERGENCE');
  }
  private pin(userId: string, deviceId: string): string {
    const key = this.pins.get(`${userId}:${deviceId}`);
    if (!key) throw new Error('UNTRUSTED_DEVICE');
    return key;
  }
  private validateWitness(content: string): Checkpoint {
    const cp = readCheckpoint(content);
    if (!cp) throw new Error('CHECKPOINT_REQUIRED');
    if (cp.chatId !== this.identity.chatId)
      throw new Error('CHECKPOINT_CHAT_MISMATCH');
    if (!verifyCheckpoint(cp, this.pin(cp.userId, cp.deviceId)))
      throw new Error('INVALID_CHECKPOINT_SIGNATURE');
    return cp;
  }
  private ownWitness(chatSeq: number, chainHash: string): Checkpoint {
    return createCheckpoint(
      {
        chatId: this.identity.chatId,
        chatSeq,
        chainHash,
        userId: this.identity.userId,
        deviceId: this.identity.deviceId,
      },
      this.identity.privateKey,
    );
  }
  private receive(content: string): void {
    if (this.witnesses.has(content)) return;
    const cp = this.validateWitness(content);
    this.commit({ kind: 'witness', content });
    this.checkPosition(cp.chatSeq);
  }
  private checkPosition(seq: number): void {
    const witnesses = this.bySequence.get(seq);
    if (!witnesses) return;
    const localHash = this.positions.get(seq);
    const remote = [...witnesses.values()];
    if (localHash) {
      for (const cp of remote) {
        if (cp.chainHash !== localHash)
          this.report(this.ownWitness(seq, localHash), cp);
      }
    }
    if (remote.length > 1) this.report(remote[0], remote[1]);
  }
  private report(left: Checkpoint, right: Checkpoint): void {
    if (left.chainHash === right.chainHash) return;
    this.blocked = true;
    const id = [left.chatSeq, ...[left.chainHash, right.chainHash].sort()].join(
      ':',
    );
    if (this.reported.has(id)) return;
    this.reported.add(id);
    this.onDivergence({
      code: 'CHAT_HISTORY_DIVERGENCE',
      chatId: this.identity.chatId,
      chatSeq: left.chatSeq,
      left,
      right,
    });
  }

  private stage(content: string, checkpointCount: number | null): void {
    if (this.pending) throw new Error('OUTBOX_NOT_EMPTY');
    const body: SignedBody = {
      chatId: this.identity.chatId,
      senderDeviceId: this.identity.deviceId,
      seq: integer(this.sentSeq + 1),
      prevHash: this.sentHash,
      content,
      signature: '',
    };
    const payload = signingPayload(body);
    body.signature = sign(
      null,
      Buffer.from(payload, 'utf8'),
      this.identity.privateKey,
    ).toString('base64');
    this.commit({
      kind: 'pending',
      pending: {
        body,
        messageHash: computeMessageHash(payload),
        checkpointCount,
      },
    });
  }
  private async flush(): Promise<void> {
    this.assertHealthy();
    const pending = this.pending;
    if (!pending) return;
    const ack = object(
      await this.request('/chats/messages', { ...pending.body }),
    );
    if (
      ack.chatId !== this.identity.chatId ||
      ack.content !== pending.body.content
    )
      throw new Error('INVALID_SEND_ACK');
    uuid(ack.messageId);
    this.commit({ kind: 'sent' });
  }

  private async loadEntries(): Promise<Entry[]> {
    const collected: Entry[] = [];
    let before: number | undefined;
    let anchored = this.head === 0;
    while (true) {
      const query =
        before === undefined ? '?limit=500' : `?limit=500&before=${before}`;
      const response = object(
        await this.request(`/chats/${this.identity.chatId}/chain${query}`),
      );
      const page = array(response.entries, 500).map(entryFrom);
      if (!page.length) break;
      let upper = before ?? Infinity;
      for (const entry of page) {
        if (entry.chatSeq >= upper) throw new Error('INVALID_CHAIN_ORDER');
        upper = entry.chatSeq;
        if (entry.chatSeq === this.head) {
          if (entry.chainHash !== this.positions.get(this.head))
            throw new Error('CHAIN_ROLLBACK_OR_FORK');
          anchored = true;
        }
        if (entry.chatSeq > this.head) collected.push(entry);
      }
      const last = page[page.length - 1].chatSeq;
      if (last <= this.head || last === 1) break;
      before = last;
    }
    if (!anchored) throw new Error('CHAIN_ANCHOR_MISSING');
    return collected.reverse();
  }

  private async loadMessages(
    entries: readonly Entry[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const needed = new Set(entries.map((entry) => entry.messageId));
    const result = new Map<string, Record<string, unknown>>();
    const cursors = new Set<string>();
    let before: string | undefined;
    while (needed.size) {
      const query =
        before === undefined
          ? '?limit=100'
          : `?limit=100&before=${encodeURIComponent(before)}`;
      const page = array(
        await this.request(`/chats/${this.identity.chatId}/messages${query}`),
        100,
      );
      if (!page.length) throw new Error('MESSAGE_NOT_AVAILABLE');
      for (const value of page) {
        const message = object(value);
        const id = uuid(message.messageId);
        if (message.chatId !== this.identity.chatId)
          throw new Error('MESSAGE_CHAT_MISMATCH');
        if (
          typeof message.content === 'string' &&
          message.content.startsWith(CHECKPOINT_PREFIX)
        ) {
          this.receive(message.content);
        }
        if (needed.delete(id)) result.set(id, message);
      }
      before = uuid(object(page[page.length - 1]).messageId);
      if (cursors.has(before)) throw new Error('HISTORY_CURSOR_LOOP');
      cursors.add(before);
    }
    return result;
  }

  private verifyMessage(
    message: Record<string, unknown>,
    entry: Entry,
  ): boolean {
    if (
      uuid(message.chatId) !== this.identity.chatId ||
      uuid(message.messageId) !== entry.messageId ||
      integer(message.chatSeq) !== entry.chatSeq ||
      hash(message.chainHash) !== entry.chainHash ||
      hash(message.messageHash) !== entry.messageHash
    )
      throw new Error('MESSAGE_CHAIN_BINDING_MISMATCH');
    const senderId = uuid(message.senderId);
    const content =
      message.content == null ? undefined : string(message.content);
    const attachments = array(message.attachments ?? []).map((value) => {
      const attachment = object(value);
      return {
        mediaId: uuid(attachment.mediaId),
        type: string(attachment.type),
      };
    });
    const contentHash = computeContentHash(content, attachments);
    const cp = readCheckpoint(content);
    let expected: string;
    if (entry.kind === 'signed') {
      const senderDeviceId = uuid(message.senderDeviceId);
      const signature = string(message.signature);
      const payload = buildSigningPayload({
        chatId: this.identity.chatId,
        senderDeviceId,
        seq: integer(message.seq),
        prevHash: hash(message.prevHash),
        contentHash,
      });
      if (
        !SIGNATURE.test(signature) ||
        !verifyEd25519(this.pin(senderId, senderDeviceId), payload, signature)
      ) {
        throw new Error('INVALID_MESSAGE_SIGNATURE');
      }
      expected = computeMessageHash(payload);
      if (
        cp &&
        (cp.userId !== senderId ||
          cp.deviceId !== senderDeviceId ||
          attachments.length)
      ) {
        throw new Error('CHECKPOINT_ENVELOPE_MISMATCH');
      }
    } else {
      if (cp) throw new Error('UNSIGNED_CHECKPOINT');
      expected = computeServerMessageHash({
        chatId: this.identity.chatId,
        messageId: entry.messageId,
        senderId,
        contentHash,
      });
    }
    if (expected !== entry.messageHash)
      throw new Error('MESSAGE_HASH_MISMATCH');
    if (cp && content !== undefined) {
      this.receive(content);
      return false;
    }
    return true;
  }

  private validateNext(entry: Entry): void {
    if (entry.chatSeq !== this.head + 1 || this.messageIds.has(entry.messageId))
      throw new Error('CHAIN_GAP_OR_DUPLICATE');
    const previous =
      this.head === 0 ? GENESIS_HASH : this.positions.get(this.head);
    if (
      !previous ||
      computeChainHash(entry.chatSeq, previous, entry.messageHash) !==
        entry.chainHash
    ) {
      throw new Error('CHAIN_HASH_MISMATCH');
    }
  }
  private commit(event: Event): void {
    this.journal.append(event);
    this.apply(event);
  }
  private apply(event: Event): void {
    switch (event.kind) {
      case 'verified':
        this.validateNext(event.entry);
        this.head = event.entry.chatSeq;
        this.positions.set(this.head, event.entry.chainHash);
        this.messageIds.add(event.entry.messageId);
        if (event.ordinary) {
          if (this.ordinaryCount === this.publishedCount)
            this.dirtySince = event.at;
          this.ordinaryCount++;
        }
        return;
      case 'witness': {
        const cp = this.validateWitness(event.content);
        this.witnesses.add(event.content);
        let hashes = this.bySequence.get(cp.chatSeq);
        if (!hashes) {
          hashes = new Map();
          this.bySequence.set(cp.chatSeq, hashes);
        }
        hashes.set(cp.chainHash, cp);
        return;
      }
      case 'pending': {
        const { body, checkpointCount } = event.pending;
        if (
          this.pending ||
          body.seq !== this.sentSeq + 1 ||
          body.prevHash !== this.sentHash ||
          body.chatId !== this.identity.chatId ||
          body.senderDeviceId !== this.identity.deviceId ||
          event.pending.messageHash !==
            computeMessageHash(signingPayload(body)) ||
          !verifyEd25519(
            this.pin(this.identity.userId, this.identity.deviceId),
            signingPayload(body),
            body.signature,
          ) ||
          (checkpointCount !== null && checkpointCount !== this.ordinaryCount)
        )
          throw new Error('CORRUPT_JOURNAL_OUTBOX');
        this.pending = event.pending;
        return;
      }
      case 'sent':
        if (!this.pending) throw new Error('CORRUPT_JOURNAL_ACK');
        this.sentSeq = this.pending.body.seq;
        this.sentHash = this.pending.messageHash;
        if (this.pending.checkpointCount !== null) {
          this.publishedCount = this.pending.checkpointCount;
          if (this.publishedCount === this.ordinaryCount) this.dirtySince = 0;
        }
        this.pending = null;
    }
  }
  private eventFrom(value: unknown): Event {
    const record = object(value);
    switch (record.kind) {
      case 'verified':
        if (typeof record.ordinary !== 'boolean')
          throw new Error('INVALID_JOURNAL_EVENT');
        return {
          kind: 'verified',
          entry: entryFrom(record.entry),
          ordinary: record.ordinary,
          at: integer(record.at, 0),
        };
      case 'witness':
        return { kind: 'witness', content: string(record.content) };
      case 'sent':
        return { kind: 'sent' };
      case 'pending': {
        const pending = object(record.pending);
        const body = object(pending.body);
        return {
          kind: 'pending',
          pending: {
            body: {
              chatId: uuid(body.chatId),
              senderDeviceId: uuid(body.senderDeviceId),
              seq: integer(body.seq),
              prevHash: hash(body.prevHash),
              content: string(body.content),
              signature: string(body.signature),
            },
            messageHash: hash(pending.messageHash),
            checkpointCount:
              pending.checkpointCount === null
                ? null
                : integer(pending.checkpointCount, 0),
          },
        };
      }
      default:
        throw new Error('INVALID_JOURNAL_EVENT');
    }
  }
}
