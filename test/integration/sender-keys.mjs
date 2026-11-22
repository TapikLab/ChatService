import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ProtocolAddress,
  SenderKeyDistributionMessage,
  SenderKeyStore,
  groupDecrypt,
  groupEncrypt,
  processSenderKeyDistributionMessage,
} from '@signalapp/libsignal-client';

class Device extends SenderKeyStore {
  records = new Map();
  async getSenderKey(sender, id) {
    return this.records.get(sender.toString() + id) ?? null;
  }
  async saveSenderKey(sender, id, record) {
    this.records.set(sender.toString() + id, record);
  }
}
const address = ProtocolAddress.new(randomUUID(), 1);
const sender = new Device();
const remaining = new Device();
const removed = new Device();
async function distribute(devices) {
  const id = randomUUID();
  const packet = await SenderKeyDistributionMessage.create(address, id, sender);
  for (const device of devices) {
    await processSenderKeyDistributionMessage(
      address,
      SenderKeyDistributionMessage.deserialize(packet.serialize()),
      device,
    );
  }
  return id;
}
async function encrypt(id, text) {
  return (
    await groupEncrypt(address, id, sender, Buffer.from(text))
  ).serialize();
}
const first = await distribute([remaining, removed]);
const before = await encrypt(first, 'before');
assert.equal(
  Buffer.from(await groupDecrypt(address, removed, before)).toString(),
  'before',
);
const second = await distribute([remaining]);
const after = await encrypt(second, 'after');
assert.equal(
  Buffer.from(await groupDecrypt(address, remaining, after)).toString(),
  'after',
);
await assert.rejects(groupDecrypt(address, removed, after));
console.log('PASS Signal Sender Keys rotation');
