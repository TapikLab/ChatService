import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  Header,
  HttpCode,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '@common/auth/jwt-auth.guard';
import { AuthenticatedRequest } from '@common/auth/authenticated-request.interface';
import { EncryptedSendService } from '@modules/messages/e2e/send/encrypted-send.service';
import type { EncryptedSendReceipt } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { GetChainQueryDto } from './dto/get-chain-query.dto';

@UseGuards(JwtAuthGuard)
@Controller('chats')
export class MessagesController {
  constructor(
    private readonly messagesService: MessagesService,
    private readonly encryptedSend: EncryptedSendService,
  ) {}

  @Post('messages')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  send(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<EncryptedSendReceipt> {
    return this.encryptedSend.send(req.user.userId, body);
  }

  @Get(':chatId/chain')
  async chain(
    @Req() req: AuthenticatedRequest,
    @Param('chatId') chatId: string,
    @Query() query: GetChainQueryDto,
  ) {
    return this.messagesService.getChain(
      chatId,
      req.user.userId,
      query.limit,
      query.before,
    );
  }
}
