import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import { MessageWriterModule } from './modules/message-writer/message-writer.module';

async function bootstrap(): Promise<void> {
  const cert = process.env.MESSAGE_WRITER_TLS_CERT_FILE;
  const key = process.env.MESSAGE_WRITER_TLS_KEY_FILE;
  if (Boolean(cert) !== Boolean(key))
    throw new Error('WRITER_TLS_CERT_AND_KEY_REQUIRED');
  const host = process.env.MESSAGE_WRITER_HOST ?? '127.0.0.1';
  if (!cert && !['127.0.0.1', '::1'].includes(host))
    throw new Error('WRITER_TLS_REQUIRED_FOR_NON_LOOPBACK_BIND');
  const app = await NestFactory.create<NestExpressApplication>(
    MessageWriterModule,
    {
      bodyParser: false,
      ...(cert && key
        ? { httpsOptions: { cert: readFileSync(cert), key: readFileSync(key) } }
        : {}),
    },
  );

  try {
    app.useBodyParser('json', { limit: '96kb', strict: true });
    app.enableShutdownHooks();
    const port = Number(
      app.get(ConfigService).get<string>('MESSAGE_WRITER_PORT') ?? '3009',
    );
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('INVALID_WRITER_PORT');

    await app.listen(port, host);
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch(() => {
  console.error('MESSAGE_WRITER_STARTUP_FAILED');
  process.exitCode = 1;
});
