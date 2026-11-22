import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { WriterAuthGuard } from './writer-http';
import { AppendEncryptedCommandDto } from './append-encrypted-command.dto';
import type { EncryptedSendReceipt } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { EncryptedSendAdmissionService } from '@modules/message-writer/send/encrypted-send-admission.service';

const commandValidation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  transform: false,
  stopAtFirstError: true,
  validationError: {
    target: false,
    value: false,
  },
});

@Controller('internal/messages')
@UseGuards(WriterAuthGuard)
export class WriterController {
  constructor(private readonly admission: EncryptedSendAdmissionService) {}

  @Post('append-encrypted')
  @HttpCode(200)
  async appendEncrypted(
    @Body(commandValidation) command: AppendEncryptedCommandDto,
  ): Promise<EncryptedSendReceipt> {
    const saved = await this.admission.send(command.senderId, command.message);

    return {
      chatId: saved.chatId,
      messageId: saved.messageId,
      messageHash: saved.messageHash,
      chatSeq: saved.chatSeq,
      chainHash: saved.chainHash,
      replayed: saved.replayed,
    };
  }
}
