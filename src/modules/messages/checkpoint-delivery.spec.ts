import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { types } from 'cassandra-driver';
import { MessagesService } from './messages.service';
import { WriterTransportService } from '../message-writer/writer-transport.service';
import { parseAppendCommand, readMutation } from '../message-writer/contract';
import { readCheckpoint } from './signing/checkpoint';
import { createCheckpoint, encodeCheckpoint } from './signing/checkpoint';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatsService } from '@modules/chats/chats.service';
import { MediaClientService } from '@modules/media-client/media-client.service';

describe('CHECKPOINT delivery', () => {
  async function fixture() {
    const rabbit = { emit: jest.fn() };
    const notification = { emit: jest.fn() };
    const assistant = { emit: jest.fn() };
    const execute = jest.fn();
    const append = jest.fn(async (value: unknown) => {
      const command = parseAppendCommand(value);
      const checkpoint = readCheckpoint(command.message.content);
      const mutation = readMutation(command.message.content);
      return {
        ...command.message,
        senderId: command.senderId,
        viaAssistant: command.viaAssistant,
        messageId: types.TimeUuid.now().toString(),
        attachments: [],
        type: checkpoint ? 'CHECKPOINT' : mutation ? mutation.type : 'text',
        chatSeq: 2,
        chainHash: 'b'.repeat(64),
        replayed: false,
      };
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
          provide: WriterTransportService,
          useValue: { append },
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
      signature: Buffer.alloc(64).toString('base64'),
    };
    return {
      module,
      service: module.get(MessagesService),
      rabbit,
      notification,
      assistant,
      execute,
      append,
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
      expect(f.append).toHaveBeenCalledTimes(1);
      expect(f.execute).not.toHaveBeenCalled();
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
  it.each(['EDIT', 'DELETE'] as const)(
    'delivers %s without push, AI or direct database writes',
    async (type) => {
      const f = await fixture();
      const target = types.TimeUuid.now().toString();
      const payload =
        type === 'EDIT' ? [1, type, target, 'new text'] : [1, type, target];
      try {
        await f.service.sendMessage(
          f.userId,
          {
            chatId: f.chatId,
            content: 'tapik.mutation.v1\n' + JSON.stringify(payload),
          },
          false,
          f.meta,
        );
        expect(f.rabbit.emit).toHaveBeenCalledWith(
          'message.sent',
          expect.objectContaining({ type }),
        );
        expect(f.notification.emit).not.toHaveBeenCalled();
        expect(f.assistant.emit).not.toHaveBeenCalled();
        expect(f.execute).not.toHaveBeenCalled();
      } finally {
        await f.module.close();
      }
    },
  );
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
