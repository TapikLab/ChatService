import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@common/auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '@common/auth/authenticated-request.interface';
import { ChatMembershipClient } from './chat-membership-client.service';
import type {
  ChatMembershipView,
  MembershipCommandReply,
} from '@modules/message-writer/chats/chat-membership-admission.service';

@Controller('chats')
@UseGuards(JwtAuthGuard)
export class ChatMembershipController {
  constructor(private readonly membership: ChatMembershipClient) {}

  @Get(':chatId/members')
  @Header('Cache-Control', 'no-store')
  getMembers(
    @Req() request: AuthenticatedRequest,
    @Param('chatId') chatId: string,
  ): Promise<ChatMembershipView> {
    return this.membership.getMembers(request.user.userId, chatId);
  }

  @Post('membership-commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  changeMembers(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<MembershipCommandReply> {
    return this.membership.changeMembers(request.user.userId, body);
  }
}
