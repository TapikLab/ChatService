import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CassandraModule } from '@common/cassandra/cassandra.module';
import { ChatAccessModule } from '@modules/chat-access/chat-access.module';
import { ChatsModule } from '@modules/chats/chats.module';
import { MediaClientModule } from '@modules/media-client/media-client.module';
import { WriterTransportService } from '@modules/message-writer/legacy/writer-transport.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { SignedMessagesService } from './signing/signed-messages.service';
import { EncryptedMessageReaderService } from '@modules/messages/e2e/history/encrypted-message-reader.service';
import { EncryptedMessagesController } from '@modules/messages/e2e/history/encrypted-messages.controller';
import { EncryptedSendService } from '@modules/messages/e2e/send/encrypted-send.service';

@Module({
  imports: [
    MediaClientModule,
    CassandraModule,
    ChatsModule,
    ChatAccessModule,
    ClientsModule.registerAsync([
      {
        name: 'RABBITMQ_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'chat_events',
            queueOptions: {
              durable: true,
            },
          },
        }),
      },
      {
        name: 'NOTIFICATION_SERVICE',
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'notification_events',
            queueOptions: {
              durable: true,
            },
          },
        }),
      },
    ]),
  ],
  providers: [
    MessagesService,
    WriterTransportService,
    SignedMessagesService,
    EncryptedMessageReaderService,
    EncryptedSendService,
  ],
  controllers: [MessagesController, EncryptedMessagesController],
  exports: [MessagesService],
})
export class MessagesModule {}
