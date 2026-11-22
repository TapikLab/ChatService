import { ConfigService } from '@nestjs/config';
import {
  Injectable,
  Logger,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import { admissionUuid } from '@modules/message-writer/admission/chat-admission.validation';
import { ChatGateway } from '@modules/gateway/chat.gateway';
import { WriterTransport } from '@modules/message-writer/client/writer-transport';
import type {
  ChatMembershipView,
  MembershipCommandReply,
} from '@modules/message-writer/chats/chat-membership-admission.service';
import { prepareMembershipCommand } from './chat-membership-command';
import { prepareCreateChat } from '@modules/chats/create-chat-command';
import type { CreatedChat } from '@modules/message-writer/chats/create-chat.service';

@Injectable()
export class ChatMembershipClient {
  private readonly logger = new Logger(ChatMembershipClient.name);
  private readonly writer: WriterTransport;
  constructor(
    config: ConfigService,
    private readonly admission: ChatAdmissionRepository,
    private readonly gateway: ChatGateway,
  ) {
    this.writer = new WriterTransport(config);
  }
  private async post(
    path: string,
    actorId: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      const { response, value } = await this.writer.post(path, {
        actorId,
        body,
      });
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const reply = value as Record<string, unknown>;
        if (response.ok) return reply;
        if (
          [400, 403, 404, 409, 503].includes(response.status) &&
          reply.statusCode === response.status &&
          typeof reply.message === 'string' &&
          /^[A-Z0-9_]{1,100}$/.test(reply.message)
        )
          throw new HttpException(reply.message, response.status);
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
    }
    throw new ServiceUnavailableException('CHAT_COMMAND_OUTCOME_UNKNOWN');
  }
  async create(actorId: string, body: unknown): Promise<CreatedChat> {
    const command = prepareCreateChat(actorId, body);
    const reply = await this.post('/internal/chats/create', actorId, body);
    if (
      reply.chatId !== command.chatId ||
      reply.type !== command.type ||
      reply.creatorId !== actorId ||
      reply.title !== command.title ||
      typeof reply.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(reply.createdAt))
    )
      throw new ServiceUnavailableException('INVALID_CREATE_CHAT_REPLY');
    return {
      chatId: command.chatId,
      creatorId: actorId,
      type: command.type,
      title: command.title,
      createdAt: reply.createdAt,
    };
  }
  async changeMembers(
    actorId: string,
    body: unknown,
  ): Promise<MembershipCommandReply> {
    const command = prepareMembershipCommand(actorId, body);
    const reply = await this.post(
      '/internal/chats/change-members',
      actorId,
      body,
    );
    if (
      reply.chatId !== command.chatId ||
      reply.kind !== command.kind ||
      reply.requestId !== command.requestId ||
      reply.membershipVersion !== command.expectedMembershipVersion + 1
    )
      throw new ServiceUnavailableException('INVALID_MEMBERSHIP_REPLY');
    const receipt = {
      chatId: command.chatId,
      kind: command.kind,
      requestId: command.requestId,
      membershipVersion: command.expectedMembershipVersion + 1,
    };
    await this.notifyRotation(receipt);
    return receipt;
  }
  async getMembers(
    actorId: string,
    chatId: string,
  ): Promise<ChatMembershipView> {
    admissionUuid(actorId);
    const snapshot = await this.admission.readState(chatId);
    if (!snapshot) {
      throw new ServiceUnavailableException('CHAT_ADMISSION_NOT_INITIALIZED');
    }

    if (!snapshot.members.some((member) => member.userId === actorId)) {
      throw new ForbiddenException('NOT_A_CHAT_MEMBER');
    }

    return Object.freeze({
      chatId: snapshot.chatId,
      membershipVersion: snapshot.membershipVersion,
      members: snapshot.members,
    });
  }

  private async notifyRotation(receipt: MembershipCommandReply): Promise<void> {
    try {
      const state = await this.admission.readState(receipt.chatId);
      if (!state || state.membershipVersion !== receipt.membershipVersion)
        return;

      const rooms = state.members.map((member) => `user:${member.userId}`);
      if (rooms.length === 0) return;

      this.gateway.server.to(rooms).emit('group.key_rotation_required', {
        eventId: `group-rotation:${state.chatId}:${state.membershipVersion}`,
        chatId: state.chatId,
        membershipVersion: state.membershipVersion,
      });
    } catch {
      this.logger.warn('GROUP_ROTATION_NOTIFICATION_UNCONFIRMED');
    }
  }
}
