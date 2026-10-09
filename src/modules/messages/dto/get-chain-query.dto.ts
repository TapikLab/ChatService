import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class GetChainQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit должен быть целым числом' })
  @Min(1, { message: 'limit должен быть от 1 до 500' })
  @Max(500, { message: 'limit должен быть от 1 до 500' })
  limit: number = 100;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'before должен быть целым числом' })
  @Min(1, { message: 'before должен быть целым числом >= 1' })
  before?: number;
}
