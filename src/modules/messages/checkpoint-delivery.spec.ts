import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { types } from 'cassandra-driver';
import { MessagesService } from './messages.service';
import { WriterTransportService } from '@modules/message-writer/legacy/writer-transport.service';
import { parseAppendCommand, readMutation } from '@modules/message-writer/legacy/contract';
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

  it.each(['CHECKPOINT', 'EDIT', 'DELETE', 'text'])('rejects plaintext %s before dispatch', async kind => {
    const { service, userId, chatId, append, rabbit, notification, assistant, module } = await fixture();
    try {
      await expect(service.sendMessage(userId, {chatId, content: kind})).rejects.toThrow('E2EE_REQUIRED');
      expect(append).not.toHaveBeenCalled();
      for (const broker of [rabbit,notification,assistant]) expect(broker.emit).not.toHaveBeenCalled();
    } finally { await module.close(); }
  });
});
