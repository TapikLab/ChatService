import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { io } from 'socket.io-client';
import { CHECKPOINT_PREFIX } from '../../src/modules/messages/signing/checkpoint';
import {
  CheckpointClient,
  object,
  rawPublicKey,
  string,
  uuid,
  type Pin,
  type Request,
} from './client';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ENV_REQUIRED:${name}`);
  return value;
}
function token(): string {
  return required('AUTH_TOKEN').replace(/^Bearer\s+/i, '');
}
function report(error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({ code: error instanceof Error ? error.message : 'UNKNOWN_ERROR' })}\n`,
  );
}
async function initialize(directory: string): Promise<void> {
  const chatId = uuid(required('CHAT_ID').toLowerCase());
  const userId = uuid(required('USER_ID').toLowerCase());
  const authorization = `Bearer ${token()}`;
  const authUrl = required('AUTH_URL').replace(/\/$/, '');
  const configPath = join(directory, 'config.json');
  if (existsSync(configPath)) throw new Error('CONFIG_ALREADY_EXISTS');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'device.pem');
  // A failed registration can be retried with the same key.
  const privateKey = existsSync(keyPath)
    ? createPrivateKey(readFileSync(keyPath))
    : generateKeyPairSync('ed25519').privateKey;
  const publicKey = rawPublicKey(privateKey);
  if (!existsSync(keyPath)) {
    writeFileSync(
      keyPath,
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { mode: 0o600, flag: 'wx' },
    );
  }
  const response = await fetch(`${authUrl}/devices`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ publicKey }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`DEVICE_REGISTRATION_HTTP_${response.status}`);
  const data: unknown = await response.json();
  const pin: Pin = { userId, deviceId: uuid(object(data).deviceId), publicKey };
  writeFileSync(
    configPath,
    `${JSON.stringify({ chatId, userId, deviceId: pin.deviceId, pins: [pin] }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write(`${JSON.stringify(pin, null, 2)}\n`);
}

async function run(directory: string): Promise<void> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(directory, 'config.json'), 'utf8'),
  );
  const config = object(parsed);
  if (!Array.isArray(config.pins)) throw new Error('PINS_REQUIRED');
  const pinValues: unknown[] = config.pins;
  const pins = pinValues.map((value): Pin => {
    const pin = object(value);
    return {
      userId: uuid(pin.userId),
      deviceId: uuid(pin.deviceId),
      publicKey: string(pin.publicKey),
    };
  });
  const chatId = uuid(config.chatId);
  const baseUrl = required('CHAT_URL').replace(/\/$/, '');
  const accessToken = token();
  const request: Request = async (path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`CHAT_HTTP_${response.status}`);
    const data: unknown = await response.json();
    return data;
  };
  const client = new CheckpointClient(
    {
      chatId,
      userId: uuid(config.userId),
      deviceId: uuid(config.deviceId),
      pins,
      privateKey: createPrivateKey(readFileSync(join(directory, 'device.pem'))),
    },
    join(directory, 'state.jsonl'),
    request,
    (event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  );
  const socket = io(baseUrl, {
    auth: { token: accessToken },
    reconnection: true,
  });
  let stopping = false;
  let activePump: Promise<void> | null = null;
  const pump = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (activePump) return activePump;
    activePump = (async () => {
      try {
        socket.emit('heartbeat');
        await client.sync();
        if (!stopping) await client.tick();
      } catch (error) {
        report(error);
      }
    })().finally(() => {
      activePump = null;
    });
    return activePump;
  };
  socket.on('message', (value: unknown) => {
    if (stopping) return;
    try {
      const event = object(value);
      if (
        event.chatId === chatId &&
        typeof event.content === 'string' &&
        event.content.startsWith(CHECKPOINT_PREFIX)
      ) {
        void client.observeCheckpoint(event.content).catch(report);
      }
    } catch (error) {
      report(error);
    }
  });
  socket.on('connect_error', () => report(new Error('REALTIME_UNAVAILABLE')));
  const timer = setInterval(() => {
    void pump();
  }, 5_000);
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', (line) => {
    if (stopping || line.length === 0) return;
    void client
      .sendText(line)
      .then(() => {
        process.stdout.write(
          `${JSON.stringify({ code: 'MESSAGE_SENT', ...client.status })}\n`,
        );
        return pump();
      })
      .catch(report);
  });
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    input.close();
    socket.disconnect();
    await activePump;
    await client.close();
  };
  process.once('SIGINT', () => {
    void stop().catch(report);
  });
  process.once('SIGTERM', () => {
    void stop().catch(report);
  });
  await pump();
}

async function main(): Promise<void> {
  const [command, path] = process.argv.slice(2);
  if ((command !== 'init' && command !== 'run') || !path)
    throw new Error('USAGE: run.ts <init|run> <state-directory>');
  if (command === 'init') await initialize(resolve(path));
  else await run(resolve(path));
}
if (require.main === module) {
  void main().catch((error: unknown) => {
    report(error);
    process.exitCode = 1;
  });
}
