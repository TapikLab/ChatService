import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MessagesService } from '../messages.service';
import { SendSignedMessageDto } from '../dto/send-signed-message.dto';
import { DeviceChainService } from './device-chain.service';
import {
  buildSigningPayload,
  computeContentHash,
  computeMessageHash,
  verifyEd25519,
} from './message-signature';
import { IdentityClientService } from '@modules/identity-client/identity-client.service';
import { RedisService } from '@common/redis/redis.service';

const SEND_LOCK_TTL_MS = 15_000;
const RELEASE_LOCK_SCRIPT = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
`;

@Injectable()
export class SignedMessagesService {
  constructor(
    private readonly identityClient: IdentityClientService,
    private readonly deviceChain: DeviceChainService,
    private readonly messagesService: MessagesService,
    private readonly redisService: RedisService,
  ) {}

  async send(userId: string, dto: SendSignedMessageDto) {
    const publicKey = await this.identityClient.getActiveDeviceKey(
      userId,
      dto.senderDeviceId,
    );
    if (!publicKey) {
      throw new ForbiddenException(
        'Устройство не зарегистрировано или отозвано',
      );
    }

    const signingPayload = buildSigningPayload({
      chatId: dto.chatId,
      senderDeviceId: dto.senderDeviceId,
      seq: dto.seq,
      prevHash: dto.prevHash,
      contentHash: computeContentHash(dto.content, dto.attachments),
    });

    if (!verifyEd25519(publicKey, signingPayload, dto.signature))
      throw new ForbiddenException('Неверная подпись сообщения');

    const messageHash = computeMessageHash(signingPayload);
    const lockKey = `lock:msg_send:${dto.chatId}:${dto.senderDeviceId}:${dto.seq}`;
    const lockToken = await this.acquireLock(lockKey);
    if (!lockToken) {
      throw new ConflictException(
        'SEND_IN_PROGRESS: запрос с этим seq уже обрабатывается, повторите',
      );
    }

    try {
      return await this.messagesService.sendMessage(userId, dto, false, {
        senderDeviceId: dto.senderDeviceId,
        seq: dto.seq,
        prevHash: dto.prevHash,
        messageHash,
        signature: dto.signature,
        claimChain: () =>
          this.deviceChain.claim({
            chatId: dto.chatId,
            deviceId: dto.senderDeviceId,
            seq: dto.seq,
            prevHash: dto.prevHash,
            messageHash,
            signature: dto.signature,
          }),
      });
    } finally {
      await this.releaseLock(lockKey, lockToken);
    }
  }

  private async acquireLock(key: string): Promise<string | null> {
    const token = randomUUID();
    const acquire = await this.redisService.client.set(
      key,
      token,
      'PX',
      SEND_LOCK_TTL_MS,
      'NX',
    );

    return acquire ? token : null;
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    await this.redisService.client.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
  }
}
