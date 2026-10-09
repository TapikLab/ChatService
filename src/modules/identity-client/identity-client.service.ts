import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, Observable } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { RedisService } from '@common/redis/redis.service';
import { buildInternalGrpcMetadata } from './internal-grpc-metadata';

const DEVICE_KEY_CACHE_TTL_SECONDS = 60;

interface GetDeviceKeyResponse {
  found: boolean;
  publicKey: string;
  revoked: boolean;
}

interface IdentityInternalGrpcService {
  getDeviceKey(
    data: { userId: string; deviceId: string },
    metadata?: Metadata,
  ): Observable<GetDeviceKeyResponse>;
}

@Injectable()
export class IdentityClientService implements OnModuleInit {
  private readonly logger = new Logger(IdentityClientService.name);
  private identityService!: IdentityInternalGrpcService;

  constructor(
    @Inject('IDENTITY_GRPC_PACKAGE') private readonly client: ClientGrpc,
    private readonly config: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    this.identityService =
      this.client.getService<IdentityInternalGrpcService>('IdentityInternal');
  }

  async getActiveDeviceKey(
    userId: string,
    deviceId: string,
  ): Promise<string | null> {
    const cacheKey = `device_key:${userId}:${deviceId}`;
    const cached = await this.redisService.client.get(cacheKey);
    if (cached) {
      return cached;
    }

    let response: GetDeviceKeyResponse;
    try {
      response = await firstValueFrom(
        this.identityService.getDeviceKey(
          { userId, deviceId },
          this.metadata(),
        ),
      );
    } catch (error) {
      this.logger.error(`AuthService.GetDeviceKey недоступен: ${error}`);
      throw new ServiceUnavailableException(
        'Не удалось проверить устройство отправителя',
      );
    }

    if (!response.found || response.revoked || !response.publicKey) {
      return null;
    }

    await this.redisService.client.set(
      cacheKey,
      response.publicKey,
      'EX',
      DEVICE_KEY_CACHE_TTL_SECONDS,
    );
    return response.publicKey;
  }

  private metadata(): Metadata {
    return buildInternalGrpcMetadata(
      this.config.getOrThrow<string>('INTERNAL_API_KEY'),
    );
  }
}
