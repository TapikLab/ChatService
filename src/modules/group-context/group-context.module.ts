import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { CassandraModule } from '@common/cassandra/cassandra.module';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import { WriterDeviceKeysService } from '@modules/message-writer/writer-device-keys.service';
import { GroupContextController } from './group-context.controller';
import { GroupContextService } from './group-context.service';

@Module({
  imports: [
    ConfigModule,
    CassandraModule,
    ClientsModule.registerAsync([
      {
        name: 'WRITER_IDENTITY',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'identity',
            protoPath: join(process.cwd(), 'dist/proto/identity.proto'),
            url: config.getOrThrow<string>('AUTH_SERVICE_GRPC_URL'),
            loader: {
              defaults: true,
            },
          },
        }),
      },
    ]),
  ],
  controllers: [GroupContextController],
  providers: [
    GroupContextService,
    ChatAdmissionRepository,
    WriterDeviceKeysService,
  ],
})
export class GroupContextModule {}
