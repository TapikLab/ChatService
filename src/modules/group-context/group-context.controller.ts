import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '@common/auth/jwt-auth.guard';
import type { AuthenticatedRequest } from '@common/auth/authenticated-request.interface';
import { GroupContextService } from './group-context.service';
import type { GroupContextResponse } from './group-context.service';

@Controller('chats')
@UseGuards(JwtAuthGuard)
export class GroupContextController {
  constructor(private readonly context: GroupContextService) {}

  @Get(':chatId/e2ee/group-context')
  @Header('Cache-Control', 'no-store')
  get(
    @Req() req: AuthenticatedRequest,
    @Param('chatId') chatId: string,
    @Query() query: unknown,
  ): Promise<GroupContextResponse> {
    return this.context.get(req.user.userId, chatId, query);
  }
}
