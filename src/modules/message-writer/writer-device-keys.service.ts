import {
  Inject,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import type { CallOptions } from '@grpc/grpc-js';
import { firstValueFrom, Observable, timeout } from 'rxjs';

interface DeviceKeyReply {
  found: boolean;
  publicKey: string;
  revoked: boolean;
}

export interface DirectoryDevice {
  deviceId: string;
  signingPublicKey: string;
  identityKey: string;
  registrationId: number;
}

export interface DeviceRoster {
  userId: string;
  rosterHash: string;
  devices: DirectoryDevice[];
}

interface DeviceRostersReply {
  rosters: DeviceRoster[];
}

function grpcCode(error: unknown): number | undefined {
  if (
    error === null ||
    typeof error !== 'object' ||
    !('code' in error) ||
    typeof error.code !== 'number'
  )
    return undefined;

  return error.code;
}

interface IdentityGrpc {
  getDeviceKey(
    input: { userId: string; deviceId: string },
    metadata: Metadata,
  ): Observable<DeviceKeyReply>;
  getDeviceRosters(
    input: { userIds: string[] },
    metadata: Metadata,
    options: CallOptions,
  ): Observable<DeviceRostersReply>;
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

  async getRosters(
    userIds: readonly string[],
  ): Promise<readonly DeviceRoster[]> {
    if (
      userIds.length === 0 ||
      userIds.length > 64 ||
      new Set(userIds).size !== userIds.length
    ) {
      throw new BadRequestException('INVALID_DIRECTORY_REQUEST');
    }

    const metadata = new Metadata();
    metadata.set(
      'x-internal-key',
      this.config.getOrThrow<string>('INTERNAL_API_KEY'),
    );

    let reply: DeviceRostersReply;
    try {
      reply = await firstValueFrom(
        this.service.getDeviceRosters({ userIds: [...userIds] }, metadata, {
          deadline: Date.now() + 3_000,
        }),
      );
    } catch (error: unknown) {
      const code = grpcCode(error);
      if (code === status.INVALID_ARGUMENT) {
        throw new BadRequestException('INVALID_DIRECTORY_REQUEST');
      }
      if (code === status.NOT_FOUND) {
        throw new NotFoundException('E2EE_USER_NOT_FOUND');
      }
      if (code === status.FAILED_PRECONDITION) {
        throw new ConflictException('E2EE_DIRECTORY_NOT_READY');
      }

      throw new ServiceUnavailableException('IDENTITY_UNAVAILABLE');
    }
    const expected = new Set(userIds);
    if (
      !Array.isArray(reply.rosters) ||
      reply.rosters.length !== expected.size
    ) {
      throw new ServiceUnavailableException('INVALID_DIRECTORY_RESPONSE');
    }

    for (const roster of reply.rosters) {
      if (
        !expected.delete(roster.userId) ||
        !Array.isArray(roster.devices) ||
        roster.devices.length === 0 ||
        roster.devices.length > 64
      ) {
        throw new ServiceUnavailableException('INVALID_DIRECTORY_RESPONSE');
      }
    }
    return reply.rosters;
  }
}
