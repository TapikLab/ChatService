'use strict';
const { Client, auth } = require('cassandra-driver');

const protectedTables = [
  'messages',
  'chat_chain_log',
  'chat_chain_claims',
  'device_chain_state',
];
const mutableTables = [
  'chats',
  'chat_members',
  'user_chats',
  'chat_read_state',
];

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(value)) {
    throw new Error('INVALID_CQL_IDENTIFIER');
  }
  return value;
}
function literal(value) {
  if (typeof value !== 'string' || value.length < 32)
    throw new Error('PASSWORD_TOO_SHORT');
  return "'" + value.replaceAll("'", "''") + "'";
}
function permissions(keyspace, chatRole, writerRole) {
  [keyspace, chatRole, writerRole].forEach(identifier);
  const queries = [];
  for (const table of protectedTables) {
    queries.push(`GRANT SELECT ON TABLE ${keyspace}.${table} TO ${chatRole}`);
    queries.push(`GRANT SELECT ON TABLE ${keyspace}.${table} TO ${writerRole}`);
    queries.push(`GRANT MODIFY ON TABLE ${keyspace}.${table} TO ${writerRole}`);
  }
  for (const table of mutableTables) {
    queries.push(`GRANT SELECT ON TABLE ${keyspace}.${table} TO ${chatRole}`);
    queries.push(`GRANT MODIFY ON TABLE ${keyspace}.${table} TO ${chatRole}`);
  }
  queries.push(
    `GRANT SELECT ON TABLE ${keyspace}.chat_members TO ${writerRole}`,
  );
  return queries;
}
function reactionPermissions(keyspace, role) {
  [keyspace, role].forEach(identifier);
  return ['SELECT', 'MODIFY'].map(
    (permission) =>
      `GRANT ${permission} ON TABLE ${keyspace}.message_reactions TO ${role}`,
  );
}
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`ENV_REQUIRED:${name}`);
  return value;
}
function adminClient() {
  return new Client({
    contactPoints: [required('SCYLLA_CONTACT_POINT')],
    localDataCenter: process.env.SCYLLA_DATACENTER || 'datacenter1',
    protocolOptions: { port: Number(process.env.SCYLLA_PORT || '9042') },
    authProvider: new auth.PlainTextAuthProvider(
      required('SCYLLA_ADMIN_USERNAME'),
      required('SCYLLA_ADMIN_PASSWORD'),
    ),
  });
}
async function migrate() {
  const keyspace = identifier(required('SCYLLA_KEYSPACE'));
  const chatRole = 'tapik_chat_v04';
  const writerRole = 'tapik_writer_v04';
  const reactionRole = 'tapik_reactions_v04';
  const reactionKeyspace = identifier(required('SCYLLA_REACTIONS_KEYSPACE'));
  const chatPassword = literal(required('CHAT_DB_PASSWORD'));
  const writerPassword = literal(required('WRITER_DB_PASSWORD'));
  const reactionPassword = literal(required('REACTIONS_DB_PASSWORD'));
  const admin = adminClient();
  try {
    await admin.connect();
    for (const role of [chatRole, writerRole, reactionRole]) {
      const existing = await admin.execute(
        'SELECT role FROM system_auth.roles WHERE role = ?',
        [role],
        { prepare: true },
      );
      if (existing.first())
        throw new Error(
          'ROLE_ALREADY_EXISTS: audit partial deployment before retrying',
        );
    }
    const reactions = await admin.execute(
      'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?',
      [reactionKeyspace, 'message_reactions'],
      { prepare: true },
    );
    if (!reactions.first()) throw new Error('REACTIONS_TABLE_REQUIRED');
    for (const table of [...protectedTables, ...mutableTables]) {
      const result = await admin.execute(
        'SELECT default_time_to_live FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?',
        [keyspace, table],
        { prepare: true },
      );
      const row = result.first();
      if (!row) throw new Error(`TABLE_REQUIRED:${table}`);
      if (
        protectedTables.includes(table) &&
        row.get('default_time_to_live') !== 0
      ) {
        throw new Error(`EXPIRING_TABLE_REQUIRES_SEPARATE_MIGRATION:${table}`);
      }
    }
    const column = await admin.execute(
      'SELECT type FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ? AND column_name = ?',
      [keyspace, 'messages', 'edit_of'],
      { prepare: true },
    );
    if (!column.first())
      await admin.execute(
        `ALTER TABLE ${keyspace}.messages ADD edit_of timeuuid`,
      );
    else if (column.first().get('type') !== 'timeuuid')
      throw new Error('INVALID_EDIT_OF_COLUMN');

    await admin.execute(
      `CREATE ROLE ${chatRole} WITH LOGIN = true AND SUPERUSER = false AND PASSWORD = ${chatPassword}`,
    );
    await admin.execute(
      `CREATE ROLE ${writerRole} WITH LOGIN = true AND SUPERUSER = false AND PASSWORD = ${writerPassword}`,
    );
    await admin.execute(
      `CREATE ROLE ${reactionRole} WITH LOGIN = true AND SUPERUSER = false AND PASSWORD = ${reactionPassword}`,
    );
    for (const query of permissions(keyspace, chatRole, writerRole))
      await admin.execute(query);
    for (const query of reactionPermissions(reactionKeyspace, reactionRole))
      await admin.execute(query);
    console.log('EPIC04_SCHEMA_AND_ROLES_CREATED');
  } finally {
    await admin.shutdown();
  }
}

module.exports = {
  protectedTables,
  mutableTables,
  permissions,
  reactionPermissions,
  identifier,
  literal,
  required,
  adminClient,
};
if (require.main === module) {
  migrate().catch(() => {
    // Driver errors may contain a CREATE ROLE statement with its password.
    console.error(
      'EPIC04_MIGRATION_FAILED: inspect schema and roles with DBA credentials; do not start services',
    );
    process.exitCode = 1;
  });
}
