const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { parse } = require('dotenv');
const { Client } = require('cassandra-driver');

async function permissions(env) {
  const role = env.SCYLLA_USERNAME;
  assert.ok(['tapik_chat_v04', 'tapik_writer_v04'].includes(role));
  assert.equal(env.SCYLLA_KEYSPACE, 'chat_alpha_messages');
  const client = new Client({
    contactPoints: ['127.0.0.1'],
    localDataCenter: 'datacenter1',
    credentials: { username: role, password: env.SCYLLA_PASSWORD },
  });
  try {
    const rows = (await client.execute('LIST ALL PERMISSIONS OF ' + role)).rows;
    return rows.map(({ permission, resource }) => permission + ' ' + resource);
  } finally {
    await client.shutdown();
  }
}

async function run() {
  const chat = await permissions(parse(readFileSync('.env')));
  const writer = await permissions(
    parse(readFileSync('.local/epic04/writer.env')),
  );
  for (const table of [
    'chats',
    'user_chats',
    'e2e_chat_admission',
    'e2e_send_operations',
  ]) {
    const resource = '<table chat_alpha_messages.' + table + '>';
    assert.ok(chat.includes('SELECT ' + resource));
    assert.ok(!chat.includes('MODIFY ' + resource));
    assert.ok(writer.includes('MODIFY ' + resource));
  }
  assert.ok(!chat.includes('MODIFY <all keyspaces>'));
  assert.ok(!chat.includes('MODIFY <keyspace chat_alpha_messages>'));
}
run()
  .then(() => console.log('PASS local ChatService and writer permissions'))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
