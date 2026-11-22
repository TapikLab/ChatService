import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CassandraModule } from '@common/cassandra/cassandra.module';
import { AuthModule } from '@common/auth/auth.module';
import { RedisModule } from '@common/redis/redis.module';
import { MessagesModule } from '@modules/messages/messages.module';
import { ChatsModule } from '@modules/chats/chats.module';
import { GatewayModule } from '@modules/gateway/gateway.module';
import { MediaClientModule } from '@modules/media-client/media-client.module';
import { GrpcInternalModule } from '@modules/grpc-internal/grpc-internal.module';
import { GroupContextModule } from '@modules/group-context/group-context.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CassandraModule,
    AuthModule,
    MessagesModule,
    ChatsModule,
    RedisModule,
    GatewayModule,
    MediaClientModule,
    GrpcInternalModule,
    GroupContextModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
