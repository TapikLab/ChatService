import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
  Param,
  HttpCode,
  Header,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '@common/auth/jwt-auth.guard';
import { AuthenticatedRequest } from '@common/auth/authenticated-request.interface';
import { ChatsService } from './chats.service';
import { ChatMembershipClient } from '@modules/chat-membership/chat-membership-client.service';
import { ChatListService } from './chat-list.service';
import type { ChatListPage } from './chat-list.service';

@UseGuards(JwtAuthGuard)
@Controller('chats')
export class ChatsController {
  constructor(
    private readonly chatsService: ChatsService,
    private readonly createChatService: ChatMembershipClient,
    private readonly chatListService: ChatListService,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.createChatService.create(req.user.userId, body);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  myChats(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    return this.chatListService.getPage(req.user.userId, query);
  }

  @Post(':chatId/read')
  markAsRead(
    @Req() req: AuthenticatedRequest,
    @Param('chatId') chatId: string,
    @Body('messageId') messageId: string,
  ) {
    return this.chatsService.markAsRead(chatId, req.user.userId, messageId);
  }
}
