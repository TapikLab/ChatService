CREATE KEYSPACE IF NOT EXISTS epic1_test WITH replication = {'class':'SimpleStrategy','replication_factor':1};

USE epic1_test;

CREATE TYPE IF NOT EXISTS attachment (media_id uuid, url text, type text, file_name text, size_bytes bigint, placeholder text);

CREATE TABLE IF NOT EXISTS chat_chain_claims (
  chat_id uuid,
  chat_seq bigint,
  message_hash text,
  message_id timeuuid,
  prev_chain_hash text,
  PRIMARY KEY ((chat_id, message_id))
);

CREATE TABLE IF NOT EXISTS chat_chain_log (
  chain_hash text,
  chat_id uuid,
  chat_seq bigint,
  kind text,
  message_hash text,
  message_id timeuuid,
  PRIMARY KEY (chat_id, chat_seq)
) WITH CLUSTERING ORDER BY (chat_seq DESC);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id uuid,
  joined_at timestamp,
  role text,
  user_id uuid,
  PRIMARY KEY (chat_id, user_id)
) WITH CLUSTERING ORDER BY (user_id ASC);

CREATE TABLE IF NOT EXISTS chat_read_state (
  chat_id uuid,
  last_read_message_id timeuuid,
  updated_at timestamp,
  user_id uuid,
  PRIMARY KEY (user_id, chat_id)
) WITH CLUSTERING ORDER BY (chat_id ASC);

CREATE TABLE IF NOT EXISTS chats (
  chat_id uuid,
  created_at timestamp,
  created_by uuid,
  creation_hash text,
  title text,
  type text,
  PRIMARY KEY (chat_id)
);

CREATE TABLE IF NOT EXISTS device_chain_state (
  chat_id uuid,
  device_id uuid,
  last_hash text,
  last_message_id timeuuid,
  last_seq bigint,
  last_signature text,
  PRIMARY KEY ((chat_id, device_id))
);

CREATE TABLE IF NOT EXISTS e2e_chat_admission (
  actor_id uuid,
  chat_id uuid,
  command_kind text,
  device_set_hash text,
  entry_key text,
  members_json text,
  membership_version bigint,
  operation_ref text,
  request_hash text,
  revision bigint,
  PRIMARY KEY (chat_id, entry_key)
) WITH CLUSTERING ORDER BY (entry_key ASC);

CREATE TABLE IF NOT EXISTS e2e_delivery_pending (
  chat_id uuid,
  message_hash text,
  message_id timeuuid,
  sender_device_id uuid,
  seq bigint,
  shard int,
  PRIMARY KEY (shard, chat_id, sender_device_id, seq)
) WITH CLUSTERING ORDER BY (chat_id ASC, sender_device_id ASC, seq ASC);

CREATE TABLE IF NOT EXISTS e2e_send_candidates (
  chat_id uuid,
  message_hash text,
  message_id timeuuid,
  request_json text,
  sender_device_id uuid,
  sender_id uuid,
  seq bigint,
  signature text,
  PRIMARY KEY ((chat_id, sender_device_id, seq), message_hash)
) WITH CLUSTERING ORDER BY (message_hash ASC);

CREATE TABLE IF NOT EXISTS e2e_send_operations (
  chat_id uuid,
  delivery_state text,
  member_ids frozen<list<uuid>>,
  message_hash text,
  message_id timeuuid,
  request_json text,
  sender_device_id uuid,
  sender_id uuid,
  seq bigint,
  signature text,
  state text,
  PRIMARY KEY ((chat_id, sender_device_id, seq))
);

CREATE TABLE IF NOT EXISTS e2e_send_recovery_pending (
  chat_id uuid,
  sender_device_id uuid,
  seq bigint,
  shard int,
  PRIMARY KEY (shard, chat_id, sender_device_id, seq)
) WITH CLUSTERING ORDER BY (chat_id ASC, sender_device_id ASC, seq ASC);

CREATE TABLE IF NOT EXISTS e2e_send_recovery_pending_v2 (
  chat_id uuid,
  created_at timestamp,
  expected_revision bigint,
  sender_device_id uuid,
  seq bigint,
  shard int,
  PRIMARY KEY (shard, chat_id, sender_device_id, seq, expected_revision)
) WITH CLUSTERING ORDER BY (chat_id ASC, sender_device_id ASC, seq ASC, expected_revision ASC);

CREATE TABLE IF NOT EXISTS messages (
  attachments list<frozen<attachment>>,
  chain_hash text,
  chat_id uuid,
  chat_seq bigint,
  content text,
  created_at timestamp,
  edit_of timeuuid,
  edited_at timestamp,
  envelope text,
  message_hash text,
  message_id timeuuid,
  prev_hash text,
  sender_device_id uuid,
  sender_id uuid,
  seq bigint,
  signature text,
  type text,
  via_assistant boolean,
  PRIMARY KEY (chat_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

CREATE TABLE IF NOT EXISTS user_chats (
  chat_id uuid,
  joined_at timestamp,
  user_id uuid,
  PRIMARY KEY (user_id, chat_id)
) WITH CLUSTERING ORDER BY (chat_id ASC);
