import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ChatGateway } from './chat.gateway';
import { RedisModule } from '@common/redis/redis.module';
import { DeliveryController } from './delivery/delivery.controller';
import { CassandraModule } from '@common/cassandra/cassandra.module';
import { EncryptedDeliveryController } from '@modules/gateway/delivery/encrypted-delivery.controller';
import { ChatAccessModule } from '@modules/chat-access/chat-access.module';

@Module({
  imports: [
    RedisModule,
    CassandraModule,
    JwtModule.registerAsync({
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
    ChatAccessModule,
  ],
  providers: [ChatGateway],
  exports: [ChatGateway],
  controllers: [DeliveryController, EncryptedDeliveryController],
})
export class GatewayModule {}
