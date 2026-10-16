import { WriterTransportService } from '../message-writer/writer-transport.service';
import { Test, TestingModule } from '@nestjs/testing';
import { MessagesService } from './messages.service';
import { MediaClientService } from '@modules/media-client/media-client.service';
import { CassandraService } from '@common/cassandra/cassandra.service';
import { ChatsService } from '@modules/chats/chats.service';
describe('MessagesService', () => {
  let service: MessagesService;
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: WriterTransportService, useValue: {} },
        { provide: MediaClientService, useValue: {} },
        { provide: CassandraService, useValue: { client: {} } },
        { provide: ChatsService, useValue: {} },
        { provide: 'RABBITMQ_SERVICE', useValue: { emit: jest.fn() } },
        { provide: 'NOTIFICATION_SERVICE', useValue: { emit: jest.fn() } },
        { provide: 'ASSISTANT_SERVICE', useValue: { emit: jest.fn() } }, // ← добавили
      ],
    }).compile();
    service = module.get<MessagesService>(MessagesService);
  });
  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
