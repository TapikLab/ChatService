import { IsObject, IsUUID, Matches } from 'class-validator';

export class AppendEncryptedCommandDto {
  @IsUUID()
  @Matches(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  senderId!: string;

  @IsObject()
  message!: Record<string, unknown>;
}
