import {
  Controller,
  Get,
  Header,
  Param,
  Req,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '@common/auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '@common/auth/authenticated-request.interface';
import { EncryptedMessageReaderService } from './encrypted-message-reader.service';
import type { EncryptedMessageResponse } from './encrypted-message-reader.service';
import type { EncryptedSyncPage } from './encrypted-message-reader.service';
import { GetEncryptedMessagesQueryDto } from '@modules/messages/dto/get-encrypted-messages-query.dto';

@UseGuards(JwtAuthGuard)
@Controller('chats')
export class EncryptedMessagesController {
  constructor(private readonly reader: EncryptedMessageReaderService) {}

  @Get(':chatId/e2e/messages/:messageId')
  @Header('Cache-Control', 'no-store')
  getOne(
    @Req() req: AuthenticatedRequest,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
  ): Promise<EncryptedMessageResponse> {
    return this.reader.getOne(req.user.userId, chatId, messageId);
  }

  @Get(':chatId/e2e/messages')
  @Header('Cache-Control', 'no-store')
  getPage(
    @Req() request: AuthenticatedRequest,
    @Param('chatId') chatId: string,
    @Query() query: GetEncryptedMessagesQueryDto,
  ): Promise<EncryptedSyncPage> {
    return this.reader.getPage(
      request.user.userId,
      chatId,
      query.after,
      query.limit,
    );
  }
}
