import { randomUUID } from 'node:crypto';
import { types } from 'cassandra-driver';
import type { CassandraService } from '@common/cassandra/cassandra.service';
import type { ChatAccessService } from '@modules/chat-access/chat-access.service';
import { prepareEncryptedMessage } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { EncryptedMessageReaderService } from './encrypted-message-reader.service';

describe('EncryptedMessageReaderService.getOne', () => {
  const sender = randomUUID();
  const chat = randomUUID();
  const senderDeviceId = randomUUID();
  const address = { userId: randomUUID(), deviceId: randomUUID() };
  const packet = { ...address, messageType: 'prekey', payload: 'AQ==' };
  const group = {
    mode: 'e2e_group_v1',
    membershipVersion: 1,
    deviceSetHash: 'a'.repeat(64),
    distributionId: randomUUID(),
  };
  const cases = [
    { mode: 'e2e_v1', recipients: [packet] },
    { ...group, kind: 'distribution', recipients: [packet] },
    { ...group, kind: 'message', recipients: [address], payload: 'Ag==' },
  ];
  it.each(cases)(
    'restores a committed $mode envelope for its recipient',
    async (envelope) => {
      const messageId = types.TimeUuid.now();
      const body = {
        chatId: chat,
        senderDeviceId,
        seq: 1,
        prevHash: '0'.repeat(64),
        signature: Buffer.alloc(64).toString('base64'),
        envelope,
      };
      const prepared = prepareEncryptedMessage(sender, body);
      const columns: Record<string, unknown> = {
        type: 'e2e_v1',
        sender_id: sender,
        sender_device_id: senderDeviceId,
        seq: types.Long.ONE,
        chat_seq: types.Long.ONE,
        envelope: prepared.serializedEnvelope,
        prev_hash: body.prevHash,
        signature: body.signature,
        chain_hash: '1'.repeat(64),
        message_hash: prepared.messageHash,
        created_at: messageId.getDate(),
        state: 'COMMITTED',
        message_id: messageId,
      };
      const execute = jest
        .fn()
        .mockResolvedValue({
          first: () => ({ get: (key: string) => columns[key] }),
        });
      const access = { isMember: jest.fn().mockResolvedValue(true) };
      const reader = new EncryptedMessageReaderService(
        { client: { execute } } as unknown as CassandraService,
        access as unknown as ChatAccessService,
      );
      const read = (user: string) =>
        reader.getOne(user, chat, messageId.toString());
      expect((await read(address.userId)).envelope).toEqual(envelope);
      await expect(read(randomUUID())).rejects.toThrow('MESSAGE_NOT_FOUND');
      columns.state = 'PENDING';
      await expect(read(address.userId)).rejects.toThrow(
        'MESSAGE_COMMIT_NOT_CONFIRMED',
      );
      access.isMember.mockResolvedValue(false);
      execute.mockClear();
      await expect(read(address.userId)).rejects.toThrow('MESSAGE_NOT_FOUND');
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
