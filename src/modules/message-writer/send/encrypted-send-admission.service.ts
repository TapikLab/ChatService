import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { prepareEncryptedMessage } from '@modules/messages/e2e/protocol/encrypted-message.contract';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import { GroupKeyAdmissionRepository } from '@modules/message-writer/admission/group-key-admission.repository';
import type { ChatAdmissionCommand } from '@modules/message-writer/admission/chat-admission.contract';
import { EncryptedMessageValidator } from './encrypted-message-validator.service';
import { EncryptedSendCandidatesService } from './encrypted-send-candidates.service';
import type { PreparedSendCandidate } from './encrypted-send-candidates.service';
import { EncryptedSendOperationsService } from './encrypted-send-operations.service';
import { EncryptedSendRecoveryService } from '@modules/message-writer/recovery/encrypted-send-recovery.service';
import { EncryptedWriterStoreService } from './encrypted-writer-store.service';
import type { StoredEncryptedMessage } from './encrypted-writer-store.service';

@Injectable()
export class EncryptedSendAdmissionService {
  constructor(
    private readonly admission: ChatAdmissionRepository,
    private readonly groupKeys: GroupKeyAdmissionRepository,
    private readonly validator: EncryptedMessageValidator,
    private readonly candidates: EncryptedSendCandidatesService,
    private readonly operations: EncryptedSendOperationsService,
    private readonly recovery: EncryptedSendRecoveryService,
    private readonly writer: EncryptedWriterStoreService,
  ) {}

  async send(senderId: string, body: unknown): Promise<StoredEncryptedMessage> {
    const prepared = prepareEncryptedMessage(senderId, body);
    const { message } = prepared;
    const entryKey = `send:${message.senderDeviceId}:${message.seq}`;
    const accepted = await this.candidates.readAcceptedCandidate(
      message.chatId,
      entryKey,
    );

    if (accepted) {
      const { candidate } = accepted;
      if (
        candidate.senderId !== senderId ||
        candidate.prepared.messageHash !== prepared.messageHash ||
        candidate.prepared.message.signature !== message.signature
      ) {
        throw new ConflictException('SEND_OPERATION_REUSED');
      }

      await this.recovery.ensurePending(
        message.chatId,
        message.senderDeviceId,
        message.seq,
        accepted.receipt.revision - 1,
      );

      return this.finishAdmission(candidate, entryKey);
    }

    const snapshot = await this.admission.readState(message.chatId);
    if (!snapshot) {
      throw new ServiceUnavailableException('CHAT_ADMISSION_NOT_INITIALIZED');
    }

    const validated = await this.validator.validateSnapshot(
      senderId,
      prepared,
      snapshot,
    );

    await this.operations.assertReadyForAdmission(senderId, prepared);
    const candidate = await this.candidates.saveCandidate(validated);

    await this.recovery.ensurePending(
      message.chatId,
      message.senderDeviceId,
      message.seq,
      snapshot.revision,
    );

    const command: ChatAdmissionCommand = {
      entryKey,
      commandKind: 'SEND',
      actorId: senderId,
      requestHash: prepared.messageHash,
      operationRef: entryKey,
    };

    const envelope = message.envelope;

    const result =
      envelope.mode === 'e2e_group_v1' && envelope.kind === 'distribution'
        ? await this.groupKeys.tryAcceptDistribution(snapshot, command, {
            senderDeviceId: message.senderDeviceId,
            distributionId: envelope.distributionId,
            deviceSetHash: envelope.deviceSetHash,
          })
        : await this.admission.tryAccept(snapshot, command, snapshot.members);

    if (result.status === 'stale') {
      throw new ServiceUnavailableException(
        'CHAT_STATE_CHANGED_RETRY_SAME_REQUEST',
      );
    }

    return this.finishAdmission(candidate, entryKey);
  }

  private async finishAdmission(
    candidate: PreparedSendCandidate,
    entryKey: string,
  ): Promise<StoredEncryptedMessage> {
    const { prepared } = candidate;
    const stored = await this.writer.recoverAccepted(
      prepared.message.chatId,
      entryKey,
    );
    if (!stored) {
      throw new ServiceUnavailableException('ACCEPTED_SEND_NOT_VISIBLE');
    }

    if (
      stored.senderId !== candidate.senderId ||
      stored.messageId !== candidate.messageId ||
      stored.messageHash !== prepared.messageHash ||
      stored.signature !== prepared.message.signature
    ) {
      throw new ServiceUnavailableException('ACCEPTED_SEND_RESULT_MISMATCH');
    }

    return stored;
  }
}
