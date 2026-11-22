// Run from ChatService: node -r ts-node/register/transpile-only -r tsconfig-paths/register test/integration/group-admission.cjs
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const {
  CassandraService,
} = require('@common/cassandra/cassandra.service');
const {
  ChatAdmissionRepository,
} = require('@modules/message-writer/admission/chat-admission.repository');
const {
  GroupKeyAdmissionRepository,
} = require('@modules/message-writer/admission/group-key-admission.repository');
const db = new CassandraService(new ConfigService());
const admission = new ChatAdmissionRepository(db);
const groups = new GroupKeyAdmissionRepository(db, admission);
async function run() {
  assert.equal(process.env.SCYLLA_KEYSPACE, 'epic1_test');
  await db.onModuleInit();
  const chat = randomUUID(),
    actor = randomUUID(),
    peer = randomUUID(),
    device = randomUUID();
  const hash = () => randomBytes(32).toString('hex');
  const entryKey = 'send:' + device + ':1';
  const command = {
    entryKey,
    operationRef: entryKey,
    commandKind: 'SEND',
    actorId: actor,
    requestHash: hash(),
  };
  const key = {
    senderDeviceId: device,
    distributionId: randomUUID(),
    deviceSetHash: hash(),
  };
  const members = [
    { userId: actor, role: 'admin' },
    { userId: peer, role: 'member' },
  ];
  await admission.initialize(chat, members);
  try {
    const state = await admission.readState(chat);
    const { generateKeyPairSync, sign } = require('node:crypto');
    const {
      EncryptedMessageValidator,
    } = require('@modules/message-writer/send/encrypted-message-validator.service');
    const {
      prepareEncryptedMessage,
    } = require('@modules/messages/e2e/protocol/encrypted-message.contract');
    const {
      computeGroupDeviceSetHash,
    } = require('@modules/messages/e2e/protocol/group-device-set');
    const signing = generateKeyPairSync('ed25519');
    const makeDevice = (deviceId) => ({
      deviceId,
      signingPublicKey: signing.publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(-32)
        .toString('base64'),
      identityKey: Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString(
        'base64',
      ),
      registrationId: 1,
    });
    const peerDevice = randomUUID();
    const rosters = [
      { userId: actor, rosterHash: hash(), devices: [makeDevice(device)] },
      { userId: peer, rosterHash: hash(), devices: [makeDevice(peerDevice)] },
    ];
    key.deviceSetHash = computeGroupDeviceSetHash(chat, 1, rosters);
    await db.client.execute(
      'INSERT INTO chats (chat_id,type) VALUES (?,?)',
      [chat, 'group'],
      { prepare: true },
    );
    const metadata = db;
    const directory = { getRosters: async () => rosters };
    const {
      GroupContextService,
    } = require('@modules/group-context/group-context.service');
    const contexts = new GroupContextService(metadata, admission, directory);
    const context = await contexts.get(actor, chat, { senderDeviceId: device });
    assert.equal(context.deviceSetHash, key.deviceSetHash);
    assert.deepEqual(context.recipients, [
      { userId: peer, deviceId: peerDevice },
    ]);
    await assert.rejects(
      contexts.get(actor, chat, { senderDeviceId: randomUUID() }),
      /DEVICE_NOT_ACTIVE/,
    );
    const validator = new EncryptedMessageValidator(
      metadata,
      directory,
      admission,
      groups,
    );
    const address = { userId: peer, deviceId: peerDevice };
    const packet = randomBytes(32).toString('base64');
    const envelope = {
      mode: 'e2e_group_v1',
      kind: 'distribution',
      membershipVersion: 1,
      deviceSetHash: key.deviceSetHash,
      distributionId: key.distributionId,
      recipients: [{ ...address, messageType: 'prekey', payload: packet }],
    };
    const signedBody = (seq, envelope) => {
      const body = {
        chatId: chat,
        senderDeviceId: device,
        seq,
        prevHash: '0'.repeat(64),
        signature: Buffer.alloc(64).toString('base64'),
        envelope,
      };
      body.signature = sign(
        null,
        Buffer.from(prepareEncryptedMessage(actor, body).signingPayload),
        signing.privateKey,
      ).toString('base64');
      return body;
    };
    const distribution = signedBody(1, envelope);
    const checked = await validator.validate(actor, distribution);
    command.requestHash = checked.prepared.messageHash;
    const message = signedBody(2, {
      ...envelope,
      kind: 'message',
      recipients: [address],
      payload: packet,
    });
    await assert.rejects(
      validator.validate(actor, message),
      /GROUP_KEY_NOT_REGISTERED/,
    );
    const {
      EncryptedSendCandidatesService,
    } = require('@modules/message-writer/send/encrypted-send-candidates.service');
    const {
      EncryptedSendOperationsService,
    } = require('@modules/message-writer/send/encrypted-send-operations.service');
    const {
      EncryptedWriterStoreService,
    } = require('@modules/message-writer/send/encrypted-writer-store.service');
    const {
      EncryptedSendRecoveryService,
    } = require('@modules/message-writer/recovery/encrypted-send-recovery.service');
    const {
      EncryptedDeliveryOutboxService,
    } = require('@modules/message-writer/outbox/encrypted-delivery-outbox.service');
    const {
      EncryptedSendAdmissionService,
    } = require('@modules/message-writer/send/encrypted-send-admission.service');
    const {
      ChatChainService,
    } = require('@modules/messages/signing/chat-chain.service');
    const {
      EncryptedMessageReaderService,
    } = require('@modules/messages/e2e/history/encrypted-message-reader.service');
    const {
      ChatAccessService,
    } = require('@modules/chat-access/chat-access.service');
    const candidates = new EncryptedSendCandidatesService(db, admission);
    const operations = new EncryptedSendOperationsService(db, candidates);
    const recovery = new EncryptedSendRecoveryService(db, admission);
    const outbox = new EncryptedDeliveryOutboxService(db);
    const store = new EncryptedWriterStoreService(
      db,
      operations,
      new ChatChainService(db),
      outbox,
    );
    const sends = new EncryptedSendAdmissionService(
      admission,
      groups,
      validator,
      candidates,
      operations,
      recovery,
      store,
    );
    const history = new EncryptedMessageReaderService(
      db,
      new ChatAccessService(admission),
    );
    await candidates.saveCandidate(checked);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        groups.tryAcceptDistribution(state, command, key),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      assert.equal(result.value.status, 'accepted');
      assert.equal(result.value.receipt.revision, 1);
    }
    assert.equal(
      (await groups.readRegistration(chat, device, key.distributionId))
        .deviceSetHash,
      key.deviceSetHash,
    );
    await assert.rejects(
      groups.tryAcceptDistribution(
        state,
        { ...command, requestHash: hash() },
        key,
      ),
      /GROUP_DISTRIBUTION_ID_REUSED/,
    );
    const stored = await sends.send(actor, distribution);
    assert.equal(stored.chatSeq, 1);
    const duplicate = await sends.send(actor, distribution);
    assert.equal(duplicate.messageId, stored.messageId);
    assert.deepEqual(
      (await history.getOne(peer, chat, stored.messageId)).envelope,
      envelope,
    );
    message.prevHash = stored.messageHash;
    message.signature = sign(
      null,
      Buffer.from(prepareEncryptedMessage(actor, message).signingPayload),
      signing.privateKey,
    ).toString('base64');
    const subsequent = await sends.send(actor, message);
    assert.equal(subsequent.chatSeq, 2);
    assert.deepEqual(
      (await history.getOne(peer, chat, subsequent.messageId)).envelope,
      message.envelope,
    );
    const page = await history.getPage(peer, chat, undefined, undefined);
    assert.deepEqual(
      page.entries.map((e) => e.message.messageId),
      [stored.messageId, subsequent.messageId],
    );
    await validator.validate(actor, message);
    await assert.rejects(
      validator.validate(actor, {
        ...message,
        envelope: { ...message.envelope, payload: 'AQ==' },
      }),
      /INVALID_MESSAGE_SIGNATURE/,
    );
    rosters[1].rosterHash = hash();
    await assert.rejects(
      validator.validate(actor, message),
      /GROUP_DEVICE_SET_CHANGED/,
    );
    const current = await admission.readState(chat);
    const remove = 'membership:' + randomUUID();
    await admission.tryAccept(
      current,
      {
        entryKey: remove,
        operationRef: remove,
        commandKind: 'REMOVE_MEMBER',
        actorId: actor,
        requestHash: hash(),
      },
      [members[0]],
    );
    await assert.rejects(
      validator.validate(actor, message),
      /GROUP_MEMBERSHIP_CHANGED/,
    );
    await assert.rejects(
      history.getOne(peer, chat, subsequent.messageId),
      /MESSAGE_NOT_FOUND/,
    );
    const send = 'send:' + device + ':3';
    const stale = await admission.tryAccept(
      current,
      { ...command, entryKey: send, operationRef: send },
      members,
    );
    assert.equal(stale.status, 'stale');
    assert.equal(await admission.readReceipt(chat, send), null);
    assert.equal((await admission.readState(chat)).membershipVersion, 2);
  } finally {
    await db.client.execute(
      'DELETE FROM e2e_chat_admission WHERE chat_id = ?',
      [chat],
      { prepare: true },
    );
  }
}
run()
  .then(() =>
    console.log(
      'PASS Scylla group distribution race, replay, conflict, removal fence',
    ),
  )
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.onApplicationShutdown());
