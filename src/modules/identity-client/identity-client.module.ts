import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { RedisModule } from '@common/redis/redis.module';
import { IdentityClientService } from './identity-client.service';

@Module({
  imports: [
    RedisModule,
    ClientsModule.registerAsync([
      {
        name: 'IDENTITY_GRPC_PACKAGE',
        useFactory: (config: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'identity',
            protoPath: join(process.cwd(), 'dist/proto/identity.proto'),
            url: config.getOrThrow<string>('AUTH_SERVICE_GRPC_URL'),
            loader: { defaults: true },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  providers: [IdentityClientService],
  exports: [IdentityClientService],
})
export class IdentityClientModule {}
