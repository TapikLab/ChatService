import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DELIVERY_SHARD_COUNT } from '@modules/message-writer/outbox/encrypted-delivery-outbox.service';
import { EncryptedSendRecoveryProcessor } from './encrypted-send-recovery-processor.service';
import type { SendRecoveryTask } from './encrypted-send-recovery.service';

@Injectable()
export class EncryptedSendRecoveryWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(EncryptedSendRecoveryWorker.name);
  private readonly cursors = new Map<number, SendRecoveryTask>();

  private shards: number[] = [];
  private nextShard = 0;
  private parallelShards = 2;
  private intervalMs = 500;
  private stopping = false;

  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly processor: EncryptedSendRecoveryProcessor,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = this.config.get<string>('SEND_RECOVERY_ENABLED', 'false');
    if (enabled !== 'true' && enabled !== 'false') {
      throw new Error('INVALID_SEND_RECOVERY_ENABLED');
    }

    if (enabled === 'false') return;

    const workerCount = this.integerSetting(
      'SEND_RECOVERY_WORKER_COUNT',
      1,
      1,
      DELIVERY_SHARD_COUNT,
    );
    const workerIndex = this.integerSetting(
      'SEND_RECOVERY_WORKER_INDEX',
      0,
      0,
      workerCount - 1,
    );

    this.parallelShards = this.integerSetting(
      'SEND_RECOVERY_PARALLEL_SHARDS',
      2,
      1,
      8,
    );

    this.intervalMs = this.integerSetting(
      'SEND_RECOVERY_INTERVAL_MS',
      500,
      100,
      60_000,
    );

    this.shards = Array.from(
      { length: DELIVERY_SHARD_COUNT },
      (_, shard) => shard,
    ).filter((shard) => shard % workerCount === workerIndex);

    this.logger.log(
      `E2EE_RECOVERY_STARTED worker=${workerIndex}/${workerCount} shards=${this.shards.length}`,
    );

    this.schedule(0);
  }

  private integerSetting(
    name: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const raw = this.config.get<string>(name);
    if (
      raw !== undefined &&
      (raw.length > 16 || !/^(0|[1-9][0-9]*)$/.test(raw))
    ) {
      throw new Error(`INVALID_${name}`);
    }

    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`INVALID_${name}`);
    }

    return value;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.runCycle();
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    try {
      await this.tick();
    } catch {
      this.logger.error('E2EE_RECOVERY_CYCLE_FAILED');
    } finally {
      this.schedule(this.intervalMs);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.shards.length === 0) return;

    const selected: number[] = [];
    const count = Math.min(this.parallelShards, this.shards.length);

    for (let index = 0; index < count; index++) {
      selected.push(this.shards[this.nextShard]!);
      this.nextShard = (this.nextShard + 1) % this.shards.length;
    }

    const results = await Promise.allSettled(
      selected.map((shard) => this.processShard(shard)),
    );

    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;

    if (failed > 0) {
      this.logger.warn(`E2EE_RECOVERY_SHARD_FAILURES count=${failed}`);
    }
  }

  private async processShard(shard: number): Promise<void> {
    if (this.stopping) return;

    const cursor = this.cursors.get(shard);
    const result = await this.processor.processPage(shard, cursor);
    if (result.nextCursor === null) {
      this.cursors.delete(shard);
    } else {
      this.cursors.set(shard, result.nextCursor);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    await this.running;
  }
}
