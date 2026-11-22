import { Controller, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { ChatsService } from '@modules/chats/chats.service';
import { InternalGrpcAuthGuard } from './internal-grpc-auth.guard';

@UseGuards(InternalGrpcAuthGuard)
@Controller()
export class GrpcChatController {
  constructor(private readonly chatsService: ChatsService) {}

  @GrpcMethod('ChatInternal', 'GetChatMembers')
  async getChatMembers(data: { chatId: string }) {
    const memberIds = await this.chatsService.getMemberIds(data.chatId);
    return { memberIds };
  }

  @GrpcMethod('ChatInternal', 'IsMember')
  async isMember(data: { chatId: string; userId: string }) {
    const isMember = await this.chatsService.isMember(data.chatId, data.userId);
    return { isMember };
  }

  @GrpcMethod('ChatInternal', 'GetDirectChats')
  async getDirectChats(data: { userId: string }) {
    const chats = await this.chatsService.getDirectChats(data.userId);
    return { chats };
  }

  @GrpcMethod('ChatInternal', 'SendMessageInternal')
  sendMessageInternal(): never {
    return this.rejectPlaintext();
  }

  @GrpcMethod('ChatInternal', 'GetUnreadMessages')
  getUnreadMessages(): never {
    return this.rejectPlaintext();
  }

  @GrpcMethod('ChatInternal', 'GetUserMessagesInChat')
  getUserMessagesInChat(): never {
    return this.rejectPlaintext();
  }

  @GrpcMethod('ChatInternal', 'GetRecentMessages')
  getRecentMessages() {
    return this.rejectPlaintext();
  }

  private rejectPlaintext(): never {
    throw new RpcException({
      code: status.FAILED_PRECONDITION,
      message: 'E2EE_REQUIRED',
    });
  }
}
