import { Module } from '@nestjs/common';
import { ChatAccessModule } from '@modules/chat-access/chat-access.module';
import { GatewayModule } from '@modules/gateway/gateway.module';
import { ChatMembershipController } from './chat-membership.controller';
import { ChatMembershipClient } from './chat-membership-client.service';
@Module({
  imports: [ChatAccessModule, GatewayModule],
  controllers: [ChatMembershipController],
  providers: [ChatMembershipClient],
  exports: [ChatMembershipClient],
})
export class ChatMembershipModule {}
