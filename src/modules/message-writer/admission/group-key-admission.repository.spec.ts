import { randomUUID } from 'node:crypto';
import type { CassandraService } from '@common/cassandra/cassandra.service';
import type { ChatAdmissionRepository } from './chat-admission.repository';
import { GroupKeyAdmissionRepository } from './group-key-admission.repository';

describe('Sender Key distribution retries', () => {
  it.each([true, false])(
    'rechecks registration after a receipt appears (same command: %s)',
    async (same) => {
      const actorId = randomUUID(),
        chatId = randomUUID(),
        senderDeviceId = randomUUID();
      const entryKey = 'send:' + senderDeviceId + ':1';
      const command = {
        commandKind: 'SEND' as const,
        actorId,
        entryKey,
        operationRef: entryKey,
        requestHash: '1'.repeat(64),
      };
      const receipt = { ...command, revision: 1, membershipVersion: 1, chatId };
      const context = {
        senderDeviceId,
        distributionId: randomUUID(),
        deviceSetHash: '2'.repeat(64),
      };
      const repository = new GroupKeyAdmissionRepository(
        {} as CassandraService,
        {
          readReceipt: jest.fn().mockResolvedValue(receipt),
        } as unknown as ChatAdmissionRepository,
      );
      const registration = jest
        .spyOn(repository, 'readRegistration')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(same ? { ...context, receipt } : null);
      const result = repository.tryAcceptDistribution(
        {
          chatId,
          revision: 0,
          membershipVersion: 1,
          members: [{ userId: actorId, role: 'admin' }],
        },
        command,
        context,
      );
      if (same)
        await expect(result).resolves.toEqual({ status: 'accepted', receipt });
      else
        await expect(result).rejects.toThrow(
          'SEND_OPERATION_ALREADY_REGISTERED',
        );
      expect(registration).toHaveBeenCalledTimes(2);
    },
  );
});
