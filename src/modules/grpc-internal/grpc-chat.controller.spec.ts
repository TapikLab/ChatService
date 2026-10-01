import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GrpcChatController } from './grpc-chat.controller';
import { ChatsService } from '@modules/chats/chats.service';
import { MessagesService } from '@modules/messages/messages.service';

describe('GrpcChatController', () => {
  let controller: GrpcChatController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GrpcChatController],
      providers: [
        { provide: ChatsService, useValue: {} },
        { provide: MessagesService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('test-key') },
        },
      ],
    }).compile();

    controller = module.get<GrpcChatController>(GrpcChatController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates GetDirectChats to ChatsService', async () => {
    const getDirectChats = jest
      .fn()
      .mockResolvedValue([{ chatId: 'chat-1', otherMemberId: 'user-2' }]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GrpcChatController],
      providers: [
        { provide: ChatsService, useValue: { getDirectChats } },
        { provide: MessagesService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('test-key') },
        },
      ],
    }).compile();
    const scopedController = module.get<GrpcChatController>(GrpcChatController);

    const result = await scopedController.getDirectChats({ userId: 'user-1' });

    expect(getDirectChats).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({
      chats: [{ chatId: 'chat-1', otherMemberId: 'user-2' }],
    });
  });
});
