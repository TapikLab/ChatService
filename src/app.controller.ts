import { Controller, Get, Header } from '@nestjs/common';

import { AppService } from './app.service';

interface AssistantHealthResponse {
  readonly status: 'ok';
  readonly assistantAvailable: false;
  readonly reason: 'TEE_NOT_IMPLEMENTED';
}

const HEALTH_RESPONSE: AssistantHealthResponse = Object.freeze({
  status: 'ok',
  assistantAvailable: false,
  reason: 'TEE_NOT_IMPLEMENTED',
});

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @Header('Cache-Control', 'no-store')
  getHealth(): AssistantHealthResponse {
    return HEALTH_RESPONSE;
  }
}
