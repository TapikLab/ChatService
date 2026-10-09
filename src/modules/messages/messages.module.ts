import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { DeviceChainService } from './signing/device-chain.service';
import { SignedMessagesService } from './signing/signed-messages.service';
import { ChatChainService } from './signing/chat-chain.service';
import { CassandraModule } from '@common/cassandra/cassandra.module';
import { RedisModule } from '@common/redis/redis.module';
import { ChatsModule } from '@modules/chats/chats.module';
import { MediaClientModule } from '@modules/media-client/media-client.module';
import { IdentityClientModule } from '@modules/identity-client/identity-client.module';

@Module({
  imports: [
    MediaClientModule,
    CassandraModule,
    ChatsModule,
    RedisModule,
    IdentityClientModule,
    ClientsModule.registerAsync([
      {
        name: 'RABBITMQ_SERVICE',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'chat_events',
            queueOptions: { durable: true },
          },
        }),
        inject: [ConfigService],
      },
    ]),
    ClientsModule.registerAsync([
      {
        name: 'NOTIFICATION_SERVICE',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'notification_events',
            queueOptions: { durable: true },
          },
        }),
        inject: [ConfigService],
      },
    ]),
    ClientsModule.registerAsync([
      {
        name: 'ASSISTANT_SERVICE',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'ai_assistant_events',
            queueOptions: { durable: true },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  providers: [
    MessagesService,
    ChatChainService,
    DeviceChainService,
    SignedMessagesService,
  ],
  controllers: [MessagesController],
  exports: [MessagesService],
})
export class MessagesModule {}
