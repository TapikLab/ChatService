import {
  Body,
  Controller,
  Post,
  HttpCode,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { IsObject, IsUUID } from 'class-validator';
import { CreateChatService } from '@modules/message-writer/chats/create-chat.service';
import { WriterAuthGuard } from './writer-http';
import { ChatMembershipAdmissionService } from '@modules/message-writer/chats/chat-membership-admission.service';

class ChatCommand {
  @IsUUID() actorId!: string;
  @IsObject() body!: Record<string, unknown>;
}
const validate = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  stopAtFirstError: true,
});
@UseGuards(WriterAuthGuard)
@Controller('internal/chats')
export class WriterChatsController {
  constructor(
    private readonly chats: CreateChatService,
    private readonly membership: ChatMembershipAdmissionService,
  ) {}
  @Post('create')
  @HttpCode(200)
  create(@Body(validate) command: ChatCommand) {
    return this.chats.create(command.actorId, command.body);
  }
  @Post('change-members')
  @HttpCode(200)
  change(@Body(validate) command: ChatCommand) {
    return this.membership.changeMembers(command.actorId, command.body);
  }
}
