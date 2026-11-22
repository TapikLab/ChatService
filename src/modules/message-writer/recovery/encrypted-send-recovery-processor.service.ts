import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EncryptedSendRecoveryService } from './encrypted-send-recovery.service';
import type { SendRecoveryTask } from './encrypted-send-recovery.service';
import { EncryptedWriterStoreService } from '@modules/message-writer/send/encrypted-writer-store.service';
import { EncryptedSendCandidatesService } from '@modules/message-writer/send/encrypted-send-candidates.service';

export type SendRecoveryOutcome =
  'WAITING_ACCEPTANCE' | 'WAITING_PUBLICATION' | 'COMPLETED' | 'DISCARDED';

export interface SendRecoveryPageResult {
  readonly nextCursor: SendRecoveryTask | null;
  readonly processed: number;
  readonly completed: number;
  readonly discarded: number;
  readonly waitingAcceptance: number;
  readonly waitingPublication: number;
  readonly failed: number;
}

@Injectable()
export class EncryptedSendRecoveryProcessor {
  private readonly logger = new Logger(EncryptedSendRecoveryProcessor.name);

  constructor(
    private readonly recovery: EncryptedSendRecoveryService,
    private readonly writer: EncryptedWriterStoreService,
    private readonly candidate: EncryptedSendCandidatesService,
  ) {}

  async processOne(task: SendRecoveryTask): Promise<SendRecoveryOutcome> {
    const entryKey = `send:${task.senderDeviceId}:${task.seq}`;
    const message = await this.writer.recoverAccepted(task.chatId, entryKey);

    if (!message) {
      const discarded = await this.recovery.discardIfStaleAndUnaccepted(task);

      return discarded ? 'DISCARDED' : 'WAITING_ACCEPTANCE';
    }

    if (
      message.chatId !== task.chatId ||
      message.senderDeviceId !== task.senderDeviceId ||
      message.seq !== task.seq
    ) {
      throw new ServiceUnavailableException('RECOVERED_MESSAGE_TASK_MISMATCH');
    }

    await this.candidate.retireCommittedCandidate(task.chatId, entryKey);

    const removed = await this.recovery.removeIfPublished(
      task,
      message.messageId,
      message.messageHash,
    );

    return removed ? 'COMPLETED' : 'WAITING_PUBLICATION';
  }

  async processPage(
    shard: number,
    after?: SendRecoveryTask,
  ): Promise<SendRecoveryPageResult> {
    const tasks = await this.recovery.readPending(shard, after);

    let completed = 0;
    let discarded = 0;
    let waitingAcceptance = 0;
    let waitingPublication = 0;
    let failed = 0;

    for (const task of tasks) {
      try {
        const outcome = await this.processOne(task);

        switch (outcome) {
          case 'COMPLETED':
            completed++;
            break;

          case 'DISCARDED':
            discarded++;
            break;

          case 'WAITING_ACCEPTANCE':
            waitingAcceptance++;
            break;

          case 'WAITING_PUBLICATION':
            waitingPublication++;
            break;
        }
      } catch {
        failed++;
      }
    }

    if (failed > 0) {
      this.logger.warn(
        `E2EE_RECOVERY_TASK_FAILURES shard=${shard} count=${failed}`,
      );
    }

    return Object.freeze({
      nextCursor: tasks.at(-1) ?? null,
      processed: tasks.length,
      completed,
      discarded,
      waitingAcceptance,
      waitingPublication,
      failed,
    });
  }
}
