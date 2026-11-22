import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

let cachedExpectedToken: Buffer | null = null;

export function writerSecret(config: ConfigService): Buffer {
  if (cachedExpectedToken) {
    return cachedExpectedToken;
  }

  const value = config.getOrThrow<string>('MESSAGE_WRITER_TOKEN');
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('MESSAGE_WRITER_TOKEN_MUST_BE_32_RANDOM_BYTES_HEX');
  }

  cachedExpectedToken = Buffer.from(`Bearer ${value}`, 'utf8');
  return cachedExpectedToken;
}

@Injectable()
export class WriterAuthGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: ConfigService) {
    this.expected = writerSecret(config);
  }

  canActivate(context: ExecutionContext): boolean {
    const authorization = context.switchToHttp().getRequest<Request>()
      .headers.authorization;

    if (typeof authorization !== 'string') {
      throw new UnauthorizedException();
    }
    if (authorization.length !== 71) {
      throw new UnauthorizedException();
    }

    const actual = Buffer.from(authorization, 'utf8');
    if (
      actual.length !== this.expected.length ||
      !timingSafeEqual(actual, this.expected)
    ) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
