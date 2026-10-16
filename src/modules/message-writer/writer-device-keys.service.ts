import {
  Inject,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, Observable, timeout } from 'rxjs';

interface DeviceKeyReply {
  found: boolean;
  publicKey: string;
  revoked: boolean;
}

interface IdentityGrpc {
  getDeviceKey(
    input: { userId: string; deviceId: string },
    metadata: Metadata,
  ): Observable<DeviceKeyReply>;
}

@Injectable()
export class WriterDeviceKeysService implements OnModuleInit {
  private service!: IdentityGrpc;

  constructor(
    @Inject('WRITER_IDENTITY') private readonly client: ClientGrpc,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.service = this.client.getService<IdentityGrpc>('IdentityInternal');
  }

  async getKey(userId: string, deviceId: string): Promise<string | null> {
    const metadata = new Metadata();
    metadata.set(
      'x-internal-key',
      this.config.getOrThrow<string>('INTERNAL_API_KEY'),
    );

    try {
      const result = await firstValueFrom(
        this.service
          .getDeviceKey({ userId, deviceId }, metadata)
          .pipe(timeout(5000)),
      );

      return result.found && !result.revoked && result.publicKey
        ? result.publicKey
        : null;
    } catch {
      throw new ServiceUnavailableException('IDENTITY_UNAVAILABLE');
    }
  }
}
