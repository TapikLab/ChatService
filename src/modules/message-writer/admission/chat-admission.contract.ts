export type ChatMemberRole = 'admin' | 'member';

export interface ChatMember {
  readonly userId: string;
  readonly role: ChatMemberRole;
}

export interface ChatAdmissionSnapshot {
  readonly chatId: string;
  readonly revision: number;
  readonly membershipVersion: number;
  readonly members: readonly ChatMember[];
}

export type ChatAdmissionCommandKind = 'SEND' | 'ADD_MEMBERS' | 'REMOVE_MEMBER';

export interface ChatAdmissionReceipt {
  readonly chatId: string;
  readonly entryKey: string;
  readonly revision: number;
  readonly membershipVersion: number;
  readonly commandKind: ChatAdmissionCommandKind;
  readonly actorId: string;
  readonly requestHash: string;
  readonly operationRef: string;
}

export interface ChatAdmissionCommand {
  readonly entryKey: string;
  readonly commandKind: ChatAdmissionCommandKind;
  readonly actorId: string;
  readonly requestHash: string;
  readonly operationRef: string;
}

export type ChatAdmissionResult =
  | {
      readonly status: 'accepted';
      readonly receipt: ChatAdmissionReceipt;
    }
  | {
      readonly status: 'stale';
    };

export interface ChatRevisionFence {
  readonly chatId: string;
  readonly closedRevision: number;
  readonly observedRevision: number;
}
