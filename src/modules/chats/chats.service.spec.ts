import { Test, TestingModule } from '@nestjs/testing';
import { ChatsService } from './chats.service';
import { CassandraService } from '@common/cassandra/cassandra.service';

describe('ChatsService', () => {
  let service: ChatsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatsService,
        { provide: CassandraService, useValue: { client: {} } },
        { provide: 'RABBITMQ_SERVICE', useValue: { emit: jest.fn() } },
        { provide: 'REACTIONS_SERVICE', useValue: { emit: jest.fn() } },
      ],
    }).useMocker(() => ({})).compile();

    service = module.get<ChatsService>(ChatsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
