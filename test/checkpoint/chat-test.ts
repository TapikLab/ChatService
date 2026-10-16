import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { io } from 'socket.io-client';
import {
  CheckpointClient,
  object,
  rawPublicKey,
  string,
  uuid,
  type Request,
} from './client';

// Copy this file inside test/checkpoint and change these settings.
export const CONFIG = {
  name: 'Alice',
  email: 'alice@example.com',
  password: process.env.TEST_PASSWORD ?? 'YOUR_PASSWORD',
  chatId: '9bc4d32b-d153-4727-8f6b-ec10f2ef6c8e',
  authUrl: 'http://localhost/auth',
  chatUrl: 'http://localhost',
  stateDir: '.tmp/chat-test-alice',
};

export interface SenderConfig {
  name: string;
  email: string;
  password: string;
  chatId: string;
  authUrl: string;
  chatUrl: string;
  stateDir: string;
}

/** Automatic login/registration; sending uses the existing durable outbox. */
export async function prepareSender(
  config: SenderConfig,
  fetcher: typeof fetch = fetch,
) {
  const chatId = uuid(config.chatId.toLowerCase());
  const authUrl = config.authUrl.replace(/\/$/, '');
  const chatUrl = config.chatUrl.replace(/\/$/, '');
  let accessToken = '';

  const json = async (
    url: string,
    body?: unknown,
    authenticated = false,
  ): Promise<unknown> => {
    const response = await fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authenticated ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`HTTP_${response.status}: ${new URL(url).pathname}`);
    const data: unknown = await response.json();
    return data;
  };

  let login = object(
    await json(`${authUrl}/login`, {
      email: config.email,
      password: config.password,
    }),
  );
  if (login.requiresTotp === true) {
    const code = process.env.TOTP_CODE;
    if (!code || !/^\d{6}$/.test(code))
      throw new Error(
        'TOTP_REQUIRED: set TOTP_CODE to your current 6-digit code',
      );
    login = object(
      await json(`${authUrl}/totp/login`, {
        tempToken: string(login.tempToken),
        code,
      }),
    );
  }
  accessToken = string(login.accessToken);
  const profile = object(await json(`${authUrl}/profile`, undefined, true));
  const userId = uuid(profile.userId);
  const directory = resolve(config.stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'device.pem');
  const identityPath = join(directory, 'identity.json');
  const saved = existsSync(identityPath)
    ? object(JSON.parse(readFileSync(identityPath, 'utf8')) as unknown)
    : null;
  if (saved && saved.userId !== userId)
    throw new Error('STATE_BELONGS_TO_ANOTHER_USER');
  if (saved && !existsSync(keyPath)) throw new Error('DEVICE_KEY_MISSING');

  const privateKey = existsSync(keyPath)
    ? createPrivateKey(readFileSync(keyPath))
    : generateKeyPairSync('ed25519').privateKey;
  const publicKey = rawPublicKey(privateKey);
  if (saved && saved.publicKey !== publicKey)
    throw new Error('DEVICE_KEY_MISMATCH');
  if (!existsSync(keyPath))
    writeFileSync(
      keyPath,
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { flag: 'wx', mode: 0o600 },
    );

  const registration = object(
    await json(`${authUrl}/devices`, { publicKey }, true),
  );
  const deviceId = uuid(registration.deviceId);
  if (registration.publicKey !== publicKey)
    throw new Error('REGISTERED_KEY_MISMATCH');
  if (saved && saved.deviceId !== deviceId)
    throw new Error('REGISTERED_DEVICE_MISMATCH');
  const pin = { userId, deviceId, publicKey };
  if (!saved)
    writeFileSync(identityPath, `${JSON.stringify(pin, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });

  const request: Request = async (path, body) =>
    json(`${chatUrl}${path}`, body, true);
  const client = new CheckpointClient(
    { chatId, userId, deviceId, privateKey, pins: [pin] },
    join(directory, `state-${chatId}.jsonl`),
    request,
    () => {
      throw new Error('UNEXPECTED_DIVERGENCE_IN_SEND_ONLY_TEST');
    },
  );
  return { client, pin, accessToken, chatId, chatUrl };
}

async function main(): Promise<void> {
  const report = (error: unknown): void => {
    console.error(
      `[${CONFIG.name}] ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}`,
    );
  };
  const session = await prepareSender(CONFIG);
  const { client } = session;
  const socket = io(session.chatUrl, { auth: { token: session.accessToken } });
  let stopping = false;
  socket.on('message', (value: unknown) => {
    try {
      const event = object(value);
      if (event.chatId === session.chatId) {
        console.log(
          `[ДОСТАВКА] chatSeq=${String(event.chatSeq)} sender=${string(event.senderId)}: ${string(event.content)}`,
        );
      }
    } catch (error) {
      report(error);
    }
  });
  socket.on('connect_error', () => report(new Error('REALTIME_UNAVAILABLE')));
  const heartbeat = setInterval(() => {
    socket.emit('heartbeat');
  }, 30_000);
  const input = createInterface({ input: process.stdin, terminal: false });
  let pendingLines: Promise<void> = Promise.resolve();
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    input.close();
    clearInterval(heartbeat);
    socket.disconnect();
    await pendingLines;
    await client.close();
  };
  input.on('line', (line) => {
    if (stopping || !line.trim()) return;
    if (line === '/quit') {
      void stop().catch(report);
      return;
    }
    pendingLines = pendingLines
      .then(async () => {
        if (line === '/retry') {
          await client.retryPending();
          console.log(
            `[${CONFIG.name}] Повтор завершён. Последний seq=${client.status.sentSeq}`,
          );
          return;
        }
        if (client.status.pending)
          throw new Error(
            'Есть незавершённая отправка. Введите /retry; новую строку отправьте после подтверждения.',
          );
        await client.sendText(line);
        console.log(
          `[${CONFIG.name}] Отправлено: seq=${client.status.sentSeq}, текст=${line}`,
        );
      })
      .catch(report);
  });
  input.on('close', () => {
    void stop().catch(report);
  });
  process.once('SIGINT', () => {
    void stop().catch(report);
  });
  process.once('SIGTERM', () => {
    void stop().catch(report);
  });
  console.log(
    `[${CONFIG.name}] Вход выполнен. chatId=${session.chatId}, deviceId=${session.pin.deviceId}`,
  );
  console.log('Введите сообщение и Enter. /retry — повтор; /quit — выход.');
  console.log(
    'Этот тест отправляет и показывает доставку. Проверка истории и checkpoint выполняется отдельным run.ts.',
  );
  if (client.status.pending) {
    try {
      await client.retryPending();
    } catch (error) {
      report(error);
    }
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'UNKNOWN_ERROR');
    process.exitCode = 1;
  });
}
