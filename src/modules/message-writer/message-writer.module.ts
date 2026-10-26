import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { CassandraModule } from '@common/cassandra/cassandra.module';
import { DeviceChainService } from '@modules/messages/signing/device-chain.service';
import { ChatChainService } from '@modules/messages/signing/chat-chain.service';
import { WriterStoreService } from './writer-store.service';
import { WriterDeviceKeysService } from './writer-device-keys.service';
import { WriterAuthGuard, WriterController } from './writer-http';
import { EncryptedMessageValidator } from './encrypted-message-validator.service';
import { EncryptedSendOperationsService } from './encrypted-send-operations.service';
import { EncryptedWriterStoreService } from './encrypted-writer-store.service';
import { EncryptedDeliveryOutboxService } from './encrypted-delivery-outbox.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    CassandraModule,
    ClientsModule.registerAsync([
      {
        name: 'WRITER_IDENTITY',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'identity',
            protoPath: join(process.cwd(), 'dist/proto/identity.proto'),
            url: config.getOrThrow<string>('AUTH_SERVICE_GRPC_URL'),
            loader: { defaults: true },
          },
        }),
      },
    ]),
  ],
  controllers: [WriterController],
  providers: [
    WriterStoreService,
    WriterDeviceKeysService,
    EncryptedMessageValidator,
    EncryptedSendOperationsService,
    EncryptedWriterStoreService,
    EncryptedDeliveryOutboxService,
    WriterAuthGuard,
    DeviceChainService,
    ChatChainService,
  ],
})
export class MessageWriterModule {}
