import { Controller, Logger, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ChatsService } from '@modules/chats/chats.service';
import { MessagesService } from '@modules/messages/messages.service';
import { InternalGrpcAuthGuard } from './internal-grpc-auth.guard';

@UseGuards(InternalGrpcAuthGuard)
@Controller()
export class GrpcChatController {
  private readonly logger = new Logger(GrpcChatController.name);

  constructor(
    private readonly chatsService: ChatsService,
    private readonly messagesService: MessagesService,
  ) {}

  @GrpcMethod('ChatInternal', 'GetChatMembers')
  async getChatMembers(data: { chatId: string }) {
    const memberIds = await this.chatsService.getMemberIds(data.chatId);
    return { memberIds };
  }

  @GrpcMethod('ChatInternal', 'IsMember')
  async isMember(data: { chatId: string; userId: string }) {
    const result = await this.chatsService.isMember(data.chatId, data.userId);
    return { isMember: result };
  }

  @GrpcMethod('ChatInternal', 'SendMessageInternal')
  async sendMessageInternal(data: {
    chatId: string;
    senderId: string;
    content: string;
    viaAssistant?: boolean;
  }) {
    try {
      const result = await this.messagesService.sendMessage(
        data.senderId,
        { chatId: data.chatId, content: data.content },
        Boolean(data.viaAssistant),
      );
      return {
        success: true,
        messageId: result.messageId,
        error: '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Ошибка внутренней отправки сообщения: ${message}`);
      return { success: false, messageId: '', error: message };
    }
  }

  @GrpcMethod('ChatInternal', 'GetUnreadMessages')
  async getUnreadMessages(data: {
    userId: string;
    maxMessagesPerChat?: number;
  }) {
    const chats = await this.chatsService.getUnreadMessages(
      data.userId,
      data.maxMessagesPerChat || undefined,
    );
    return { chats };
  }

  @GrpcMethod('ChatInternal', 'GetUserMessagesInChat')
  async getUserMessagesInChat(data: {
    chatId: string;
    userId: string;
    limit?: number;
  }) {
    const messages = await this.chatsService.getUserMessagesInChat(
      data.chatId,
      data.userId,
      data.limit || undefined,
    );
    return { messages };
  }

  @GrpcMethod('ChatInternal', 'GetRecentMessages')
  async getRecentMessages(data: { chatId: string; limit?: number }) {
    const messages = await this.chatsService.getRecentMessages(
      data.chatId,
      data.limit || undefined,
    );
    return { messages };
  }

  @GrpcMethod('ChatInternal', 'GetDirectChats')
  async getDirectChats(data: { userId: string }) {
    const chats = await this.chatsService.getDirectChats(data.userId);
    return { chats };
  }
}
