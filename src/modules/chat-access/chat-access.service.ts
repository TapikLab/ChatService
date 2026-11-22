import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import type {
  ChatAdmissionSnapshot,
  ChatMemberRole,
} from '@modules/message-writer/admission/chat-admission.contract';
import { admissionUuid } from '@modules/message-writer/admission/chat-admission.validation';

@Injectable()
export class ChatAccessService {
  constructor(private readonly admission: ChatAdmissionRepository) {}

  async getSnapshot(chatId: string): Promise<ChatAdmissionSnapshot> {
    admissionUuid(chatId);

    const snapshot = await this.admission.readState(chatId);
    if (!snapshot) {
      throw new ServiceUnavailableException('CHAT_ADMISSION_NOT_INITIALIZED');
    }

    return snapshot;
  }

  async isMember(chatId: string, userId: string): Promise<boolean> {
    return (await this.getRole(chatId, userId)) !== null;
  }

  async getRole(
    chatId: string,
    userId: string,
  ): Promise<ChatMemberRole | null> {
    admissionUuid(userId);
    const snapshot = await this.getSnapshot(chatId);
    return (
      snapshot?.members.find((member) => member.userId === userId)?.role ?? null
    );
  }

  async getMemberIds(chatId: string): Promise<string[]> {
    const snapshot = await this.getSnapshot(chatId);
    return snapshot.members.map((member) => member.userId);
  }

  async selectMembers(
    chatId: string,
    userIds: readonly string[],
  ): Promise<readonly string[]> {
    if (!Array.isArray(userIds) || userIds.length > 65) {
      throw new BadRequestException('INVALID_ACCESS_USER_LIST');
    }

    const requested = new Set<string>();
    for (const userId of userIds) {
      requested.add(admissionUuid(userId));
    }

    const snapshot = await this.getSnapshot(chatId);
    const allowed = snapshot.members
      .filter((member) => requested.has(member.userId))
      .map((member) => member.userId);

    return Object.freeze(allowed);
  }
}
