import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { types } from 'cassandra-driver';
import { MessagesService } from './messages.service';
import { ChatChainService } from './signing/chat-chain.service';
import { createCheckpoint, encodeCheckpoint } from './signing/checkpoint';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatsService } from '@modules/chats/chats.service';
import { MediaClientService } from '@modules/media-client/media-client.service';

describe('CHECKPOINT delivery', () => {
  async function fixture() {
    const rabbit = { emit: jest.fn() };
    const notification = { emit: jest.fn() };
    const assistant = { emit: jest.fn() };
    const execute = jest.fn((query: string, params: unknown[]) => {
      expect(Array.isArray(params)).toBe(true);
      return Promise.resolve(
        query.startsWith('SELECT')
          ? { rowLength: 0, first: () => null }
          : { wasApplied: () => true },
      );
    });
    const module = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: MediaClientService, useValue: {} },
        { provide: CassandraService, useValue: { client: { execute } } },
        {
          provide: ChatsService,
          useValue: {
            assertMember: jest.fn().mockResolvedValue(undefined),
            getMemberIds: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: ChatChainService,
          useValue: {
            append: jest
              .fn()
              .mockResolvedValue({ chatSeq: 2, chainHash: 'b'.repeat(64) }),
          },
        },
        { provide: 'RABBITMQ_SERVICE', useValue: rabbit },
        { provide: 'NOTIFICATION_SERVICE', useValue: notification },
        { provide: 'ASSISTANT_SERVICE', useValue: assistant },
      ],
    }).compile();
    const userId = randomUUID();
    const deviceId = randomUUID();
    const chatId = randomUUID();
    const content = encodeCheckpoint(
      createCheckpoint(
        { chatId, chatSeq: 1, chainHash: 'a'.repeat(64), userId, deviceId },
        generateKeyPairSync('ed25519').privateKey,
      ),
    );
    const meta = {
      senderDeviceId: deviceId,
      seq: 1,
      prevHash: '0'.repeat(64),
      messageHash: 'c'.repeat(64),
      signature: Buffer.alloc(64).toString('base64'),
      claimChain: () => Promise.resolve(types.TimeUuid.now()),
    };
    return {
      module,
      service: module.get(MessagesService),
      rabbit,
      notification,
      assistant,
      execute,
      userId,
      chatId,
      content,
      meta,
    };
  }

  it('stores and delivers CHECKPOINT without push or AI events', async () => {
    const f = await fixture();
    try {
      await f.service.sendMessage(
        f.userId,
        { chatId: f.chatId, content: f.content },
        false,
        f.meta,
      );
      expect(f.rabbit.emit).toHaveBeenCalledWith(
        'message.sent',
        expect.objectContaining({ type: 'CHECKPOINT', content: f.content }),
      );
      expect(f.notification.emit).not.toHaveBeenCalled();
      expect(f.assistant.emit).not.toHaveBeenCalled();
      const insertion = f.execute.mock.calls.find(([query]) =>
        query.startsWith('INSERT INTO messages'),
      );
      expect(insertion?.[1]).toContain('CHECKPOINT');
    } finally {
      await f.module.close();
    }
  });
  it('preserves push and AI events for ordinary messages', async () => {
    const f = await fixture();
    try {
      await f.service.sendMessage(
        f.userId,
        { chatId: f.chatId, content: 'hello' },
        false,
        f.meta,
      );
      expect(f.rabbit.emit).toHaveBeenCalledWith(
        'message.sent',
        expect.objectContaining({ type: 'text' }),
      );
      expect(f.notification.emit).toHaveBeenCalledTimes(1);
      expect(f.assistant.emit).toHaveBeenCalledTimes(1);
    } finally {
      await f.module.close();
    }
  });
  it.each(['unsigned', 'assistant', 'attachments'] as const)(
    'rejects %s checkpoint messages',
    async (mode) => {
      const f = await fixture();
      try {
        await expect(
          f.service.sendMessage(
            f.userId,
            {
              chatId: f.chatId,
              content: f.content,
              ...(mode === 'attachments'
                ? { attachments: [{ mediaId: randomUUID(), type: 'file' }] }
                : {}),
            },
            mode === 'assistant',
            mode === 'unsigned' ? undefined : f.meta,
          ),
        ).rejects.toThrow('INVALID_CHECKPOINT_MESSAGE');
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.rabbit.emit).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    },
  );
});
