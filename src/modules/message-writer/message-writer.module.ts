import { WriterChatsController } from '@modules/message-writer/http/writer-chats.controller';
import { ChatMembershipAdmissionService } from '@modules/message-writer/chats/chat-membership-admission.service';
import { CreateChatService } from '@modules/message-writer/chats/create-chat.service';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { CassandraModule } from '@common/cassandra/cassandra.module';
import { DeviceChainService } from '@modules/messages/signing/device-chain.service';
import { ChatChainService } from '@modules/messages/signing/chat-chain.service';
import { WriterStoreService } from '@modules/message-writer/legacy/writer-store.service';
import { WriterDeviceKeysService } from './writer-device-keys.service';
import { EncryptedMessageValidator } from '@modules/message-writer/send/encrypted-message-validator.service';
import { EncryptedSendOperationsService } from '@modules/message-writer/send/encrypted-send-operations.service';
import { EncryptedWriterStoreService } from '@modules/message-writer/send/encrypted-writer-store.service';
import { EncryptedDeliveryOutboxService } from '@modules/message-writer/outbox/encrypted-delivery-outbox.service';
import { EncryptedEventPublisher } from '@modules/message-writer/outbox/encrypted-event-publisher.service';
import { EncryptedDeliveryWorker } from '@modules/message-writer/outbox/encrypted-delivery-worker.service';
import { WriterAuthGuard } from '@modules/message-writer/http/writer-http';
import { WriterController } from '@modules/message-writer/http/writer.controller';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import { EncryptedSendCandidatesService } from '@modules/message-writer/send/encrypted-send-candidates.service';
import { EncryptedSendRecoveryService } from '@modules/message-writer/recovery/encrypted-send-recovery.service';
import { EncryptedSendRecoveryProcessor } from '@modules/message-writer/recovery/encrypted-send-recovery-processor.service';
import { EncryptedSendAdmissionService } from '@modules/message-writer/send/encrypted-send-admission.service';
import { EncryptedSendRecoveryWorker } from '@modules/message-writer/recovery/encrypted-send-recovery-worker.service';
import { GroupKeyAdmissionRepository } from '@modules/message-writer/admission/group-key-admission.repository';

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
  controllers: [WriterController, WriterChatsController],
  providers: [
    CreateChatService,
    ChatMembershipAdmissionService,
    WriterStoreService,
    WriterDeviceKeysService,
    EncryptedMessageValidator,
    EncryptedSendOperationsService,
    EncryptedWriterStoreService,
    EncryptedDeliveryOutboxService,
    EncryptedEventPublisher,
    EncryptedDeliveryWorker,
    EncryptedSendCandidatesService,
    EncryptedSendRecoveryService,
    EncryptedSendRecoveryProcessor,
    EncryptedSendAdmissionService,
    EncryptedSendRecoveryWorker,
    WriterAuthGuard,
    DeviceChainService,
    ChatChainService,
    ChatAdmissionRepository,
    GroupKeyAdmissionRepository,
  ],
})
export class MessageWriterModule {}
