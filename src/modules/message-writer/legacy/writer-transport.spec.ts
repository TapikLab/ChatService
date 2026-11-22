import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { types } from 'cassandra-driver';
import { WriterTransportService } from './writer-transport.service';
import { type AppendCommand } from './contract';

describe('server-to-server writer transport', () => {
  const configuration: Record<string, string> = {
    MESSAGE_WRITER_URL: 'http://127.0.0.1:3009',
    MESSAGE_WRITER_TOKEN: 'a'.repeat(64),
  };
  const config = {
    getOrThrow: (key: string) => configuration[key],
  } as unknown as ConfigService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let command: AppendCommand;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    command = {
      version: 1,
      senderId: randomUUID(),
      viaAssistant: true,
      message: { chatId: randomUUID(), content: 'hello' },
      messageId: types.TimeUuid.now().toString(),
    };
  });
  afterEach(() => fetchMock.mockRestore());

  function response(replayed = false): Response {
    return new Response(
      JSON.stringify({
        ...command.message,
        senderId: command.senderId,
        messageId: command.messageId,
        type: 'text',
        attachments: [],
        chatSeq: 1,
        chainHash: 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        replayed,
      }),
      { status: 201 },
    );
  }
  it('retries with the identical serialized body after a transport failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(response(true));
    const reply = await new WriterTransportService(config).append(command);
    expect(reply.replayed).toBe(true);
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      fetchMock.mock.calls[1][1]?.body,
    );
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('does not retry rejected commands or expose internal error bodies', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('sensitive database diagnostics', { status: 409 }),
    );
    await expect(
      new WriterTransportService(config).append(command),
    ).rejects.toThrow('MESSAGE_WRITER_REJECTED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('fails closed when writer is unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(
      new WriterTransportService(config).append(command),
    ).rejects.toThrow('MESSAGE_WRITER_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('refuses unencrypted non-loopback destinations', () => {
    const unsafe = {
      getOrThrow: (key: string) =>
        key === 'MESSAGE_WRITER_URL'
          ? 'http://writer.internal:3009'
          : 'a'.repeat(64),
    } as unknown as ConfigService;
    expect(() => new WriterTransportService(unsafe)).toThrow(
      'WRITER_HTTPS_OR_LOOPBACK_REQUIRED',
    );
  });
});
