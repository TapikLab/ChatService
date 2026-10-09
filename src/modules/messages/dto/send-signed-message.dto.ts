import { IsInt, IsUUID, Matches, Max, Min } from 'class-validator';
import { SendMessageDto } from './send-message.dto';

export class SendSignedMessageDto extends SendMessageDto {
  @IsUUID()
  senderDeviceId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  seq!: number;

  @Matches(/^[0-9a-f]{64}$/, { message: 'prevHash: 64 hex-символа' })
  prevHash!: string;

  @Matches(/^[A-Za-z0-9+/]{86}==$/, {
    message: 'signature: base64 от 64 байт Ed25519',
  })
  signature!: string;
}
