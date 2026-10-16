'use strict';
// Run only against a disposable/staging Scylla node with PasswordAuthenticator
// and CassandraAuthorizer. Creates and removes its own keyspace and roles.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client, auth, types } = require('cassandra-driver');
const {
  protectedTables,
  mutableTables,
  permissions,
  literal,
  required,
  adminClient,
} = require('./epic04-migrate.cjs');

async function main() {
  if (process.env.EPIC04_ALLOW_DISPOSABLE_DB_TEST !== 'yes')
    throw new Error('DISPOSABLE_DB_TEST_OPT_IN_REQUIRED');
  const suffix = randomBytes(6).toString('hex');
  const keyspace = `epic04_test_${suffix}`;
  const chatRole = `epic04_chat_${suffix}`;
  const writerRole = `epic04_writer_${suffix}`;
  const chatPassword = randomBytes(32).toString('hex');
  const writerPassword = randomBytes(32).toString('hex');
  const admin = adminClient();
  const clients = [];
  const createdRoles = [];
  let createdKeyspace = false;
  let checked = 0;
  function client(username, password) {
    const result = new Client({
      contactPoints: [required('SCYLLA_CONTACT_POINT')],
      localDataCenter: process.env.SCYLLA_DATACENTER || 'datacenter1',
      keyspace,
      protocolOptions: { port: Number(process.env.SCYLLA_PORT || '9042') },
      authProvider: new auth.PlainTextAuthProvider(username, password),
    });
    clients.push(result);
    return result;
  }
  try {
    await admin.connect();
    await admin.execute(
      `CREATE KEYSPACE ${keyspace} WITH replication = {'class':'SimpleStrategy','replication_factor':1}`,
    );
    createdKeyspace = true;
    for (const table of [...protectedTables, ...mutableTables]) {
      await admin.execute(
        `CREATE TABLE ${keyspace}.${table} (id text PRIMARY KEY, content text)`,
      );
    }
    await admin.execute(
      `CREATE ROLE ${chatRole} WITH LOGIN = true AND SUPERUSER = false AND PASSWORD = ${literal(chatPassword)}`,
    );
    createdRoles.push(chatRole);
    await admin.execute(
      `CREATE ROLE ${writerRole} WITH LOGIN = true AND SUPERUSER = false AND PASSWORD = ${literal(writerPassword)}`,
    );
    createdRoles.push(writerRole);
    for (const query of permissions(keyspace, chatRole, writerRole))
      await admin.execute(query);
    const reader = client(chatRole, chatPassword);
    const writer = client(writerRole, writerPassword);
    await reader.connect();
    await writer.connect();
    await assert.rejects(
      client(chatRole, randomBytes(32).toString('hex')).connect(),
    );
    checked++;

    for (const table of protectedTables) {
      const first = await writer.execute(
        `INSERT INTO ${table} (id, content) VALUES ('original','first') IF NOT EXISTS`,
      );
      assert.equal(first.wasApplied(), true);
      const replay = await writer.execute(
        `INSERT INTO ${table} (id, content) VALUES ('original','replacement') IF NOT EXISTS`,
      );
      assert.equal(replay.wasApplied(), false);
      assert.equal(
        (
          await reader.execute(
            `SELECT content FROM ${table} WHERE id = 'original'`,
          )
        )
          .first()
          .get('content'),
        'first',
      );
      checked += 3;
      for (const query of [
        `INSERT INTO ${table} (id, content) VALUES ('original','replacement')`,
        `INSERT INTO ${table} (id, content) VALUES ('new','expires') USING TTL 1`,
        `UPDATE ${table} SET content = 'replacement' WHERE id = 'original'`,
        `DELETE FROM ${table} WHERE id = 'original'`,
        `TRUNCATE ${table}`,
      ]) {
        await assert.rejects(
          reader.execute(query),
          (error) =>
            error instanceof Error &&
            error.code === types.responseErrorCodes.unauthorized,
        );
        checked++;
      }
    }
    await reader.execute(
      "INSERT INTO chat_read_state (id, content) VALUES ('reader','cursor')",
    );
    await assert.rejects(
      writer.execute(
        "UPDATE chat_members SET content = 'admin' WHERE id = 'intruder'",
      ),
      (error) =>
        error instanceof Error &&
        error.code === types.responseErrorCodes.unauthorized,
    );
    checked += 2;
    console.log(`EPIC04_DATABASE_PERMISSIONS_PASS checks=${checked}`);
  } finally {
    await Promise.allSettled(clients.map((c) => c.shutdown()));
    try {
      if (createdKeyspace) await admin.execute(`DROP KEYSPACE ${keyspace}`);
      for (const role of createdRoles.reverse())
        await admin.execute(`DROP ROLE ${role}`);
    } finally {
      await admin.shutdown();
    }
  }
}
main().catch((error) => {
  console.error(
    'EPIC04_DATABASE_TEST_FAILED',
    error instanceof Error ? error.name : 'unknown',
  );
  process.exitCode = 1;
});
