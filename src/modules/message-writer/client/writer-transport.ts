import { ConfigService } from '@nestjs/config';
const MAX_REPLY_BYTES = 8 * 1024;

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error('EMPTY_WRITER_REPLY');
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > MAX_REPLY_BYTES) {
        throw new Error('WRITER_REPLY_TOO_LARGE');
      }

      chunks.push(Buffer.from(value));
    }

    const parsed: unknown = JSON.parse(
      Buffer.concat(chunks, total).toString('utf8'),
    );
    return parsed;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class WriterTransport {
  private readonly base: URL;
  private readonly token: string;

  constructor(config: ConfigService) {
    this.base = new URL(config.getOrThrow<string>('MESSAGE_WRITER_URL'));
    const local =
      this.base.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname);
    if (
      this.base.username ||
      this.base.password ||
      (!local && this.base.protocol !== 'https:')
    )
      throw new Error('WRITER_HTTPS_OR_LOOPBACK_REQUIRED');
    this.token = config.getOrThrow<string>('MESSAGE_WRITER_TOKEN');
    if (!/^[0-9a-f]{64}$/.test(this.token))
      throw new Error('INVALID_WRITER_TOKEN');
  }

  async post(path: string, command: unknown) {
    const response = await fetch(new URL(path, this.base), {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(15000),
    });
    return { response, value: await readBoundedJson(response) };
  }
}
