import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class GetEncryptedMessagesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^(0|[1-9][0-9]*)$/)
  after?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:[1-9]|10)$/)
  limit?: string;
}
