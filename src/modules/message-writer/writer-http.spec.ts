import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WriterAuthGuard, WriterController } from './writer-http';
import { WriterStoreService } from './writer-store.service';
import { parseAppendCommand } from './contract';

describe('writer HTTP boundary', () => {
  let app: INestApplication;
  const append = jest.fn(async (body: unknown) => parseAppendCommand(body));
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WriterController],
      providers: [
        WriterAuthGuard,
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => 'a'.repeat(64) },
        },
        { provide: WriterStoreService, useValue: { append } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => append.mockClear());

  it('rejects a missing secret before calling storage', async () => {
    await request(app.getHttpServer())
      .post('/internal/messages/append')
      .send({})
      .expect(401);
    expect(append).not.toHaveBeenCalled();
  });
  it('rejects an incorrect secret', async () => {
    await request(app.getHttpServer())
      .post('/internal/messages/append')
      .set('Authorization', `Bearer ${'b'.repeat(64)}`)
      .send({})
      .expect(401);
    expect(append).not.toHaveBeenCalled();
  });
  it('does not expose a generic CQL endpoint', async () => {
    await request(app.getHttpServer())
      .post('/internal/messages/execute')
      .set('Authorization', `Bearer ${'a'.repeat(64)}`)
      .send({ query: 'DELETE FROM messages' })
      .expect(404);
    expect(append).not.toHaveBeenCalled();
  });
  it('rejects arbitrary commands on the append endpoint', async () => {
    await request(app.getHttpServer())
      .post('/internal/messages/append')
      .set('Authorization', `Bearer ${'a'.repeat(64)}`)
      .send({ query: 'TRUNCATE messages' })
      .expect(400);
  });
});
