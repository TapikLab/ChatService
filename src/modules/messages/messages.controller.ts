import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';
import { SignedMessagesService } from './signing/signed-messages.service';
import { JwtAuthGuard } from '@common/auth/jwt-auth.guard';
import { AuthenticatedRequest } from '@common/auth/authenticated-request.interface';
import { SendSignedMessageDto } from './dto/send-signed-message.dto';
import { GetChainQueryDto } from './dto/get-chain-query.dto';

@UseGuards(JwtAuthGuard)
@Controller('chats')
export class MessagesController {
  constructor(
    private readonly messagesService: MessagesService,
    private readonly signedMessagesService: SignedMessagesService,
  ) {}

  @Post('messages')
  send(@Req() req: AuthenticatedRequest, @Body() dto: SendSignedMessageDto) {
    return this.signedMessagesService.send(req.user.userId, dto);
  }

  @Get(':chatId/messages')
  history(
    @Req() req: AuthenticatedRequest,
    @Param('chatId') chatId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const parsedLimit: number = limit === undefined ? 50 : Number(limit);
    if (
      !Number.isInteger(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > 100
    ) {
      throw new BadRequestException(
        'limit должен быть целым числом от 1 до 100',
      );
    }
    return this.messagesService.getHistory(
      chatId,
      req.user.userId,
      parsedLimit,
      before,
    );
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
