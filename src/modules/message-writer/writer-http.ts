import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Injectable,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { WriterStoreService } from './writer-store.service';

// Кешируем значение на уровне файла, чтобы не дергать ConfigService при каждом запросе
let cachedExpectedToken: Buffer | null = null;

export function writerSecret(config: ConfigService): Buffer {
  if (cachedExpectedToken) {
    return cachedExpectedToken;
  }

  const value = config.getOrThrow<string>('MESSAGE_WRITER_TOKEN');
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('MESSAGE_WRITER_TOKEN_MUST_BE_32_RANDOM_BYTES_HEX');
  }

  // Сразу переводим в Buffer с префиксом при старте приложения
  cachedExpectedToken = Buffer.from(`Bearer ${value}`, 'utf8');
  return cachedExpectedToken;
}

@Injectable()
export class WriterAuthGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: ConfigService) {
    // Получаем уже подготовленный и закешированный буфер
    this.expected = writerSecret(config);
  }

  canActivate(context: ExecutionContext): boolean {
    const authorization = context.switchToHttp().getRequest<Request>()
      .headers.authorization;

    if (typeof authorization !== 'string') {
      throw new UnauthorizedException();
    }

    // Быстрая проверка длины строк (в байтах) до создания буфера
    // Длина "Bearer " (7 символов) + 64 символа токена = 71 байт/символ
    if (authorization.length !== 71) {
      throw new UnauthorizedException();
    }

    // Создаем буфер только для валидного по длине заголовка
    const actual = Buffer.from(authorization, 'utf8');

    // timingSafeEqual выбросит ошибку, если длины буферов не равны,
    // поэтому предварительная проверка длины обязательна
    if (
      actual.length !== this.expected.length ||
      !timingSafeEqual(actual, this.expected)
    ) {
      throw new UnauthorizedException();
    }

    return true;
  }
}

@Controller('internal/messages')
@UseGuards(WriterAuthGuard)
export class WriterController {
  constructor(private readonly store: WriterStoreService) {}
  @Post('append')
  append(@Body() body: unknown) {
    return this.store.append(body);
  }
}
