import { Injectable } from '@nestjs/common';
import { MessagesService } from '@modules/messages/messages.service';
import { SendSignedMessageDto } from '@modules/messages/dto/send-signed-message.dto';

@Injectable()
export class SignedMessagesService {
  constructor(private readonly messagesService: MessagesService) {}

  send(userId: string, dto: SendSignedMessageDto) {
    return this.messagesService.sendMessage(userId, dto, false, {
      senderDeviceId: dto.senderDeviceId,
      seq: dto.seq,
      prevHash: dto.prevHash,
      signature: dto.signature,
    });
  }
}
