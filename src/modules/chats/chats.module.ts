import { Module } from '@nestjs/common';
import { ChatsController } from './chats.controller';
import { ChatsService } from './chats.service';
import { CassandraModule } from '@common/cassandra/cassandra.module';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { ChatAccessModule } from '@modules/chat-access/chat-access.module';
import { ChatListService } from './chat-list.service';
import { ChatMembershipModule } from '@modules/chat-membership/chat-membership.module';

@Module({
  imports: [
    CassandraModule,
    ChatAccessModule,
    ChatMembershipModule,
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
  ],
  controllers: [ChatsController],
  providers: [ChatsService, ChatListService],
  exports: [ChatsService],
})
export class ChatsModule {}
