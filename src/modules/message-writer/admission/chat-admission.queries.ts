export const INITIALIZE_CHAT_ADMISSION = `
  INSERT INTO e2e_chat_admission (
    chat_id,
    entry_key,
    revision,
    membership_version,
    members_json
  )
  VALUES (?, 'state', ?, ?, ?)
  IF NOT EXISTS
`;

export const READ_CHAT_ADMISSION_STATE = `
  SELECT
    revision,
    membership_version,
    members_json
  FROM e2e_chat_admission
  WHERE chat_id = ?
    AND entry_key = 'state'
`;

export const READ_CHAT_ADMISSION_RECEIPT = `
  SELECT
    revision,
    membership_version,
    command_kind,
    actor_id,
    request_hash,
    operation_ref
  FROM e2e_chat_admission
  WHERE chat_id = ?
    AND entry_key = ?
`;

export const ACCEPT_CHAT_COMMAND = `
  BEGIN BATCH

    UPDATE e2e_chat_admission
    SET
      revision = ?,
      membership_version = ?,
      members_json = ?
    WHERE chat_id = ?
      AND entry_key = 'state'
    IF revision = ?
      AND membership_version = ?
      AND members_json = ?;

    INSERT INTO e2e_chat_admission (
      chat_id,
      entry_key,
      revision,
      membership_version,
      command_kind,
      actor_id,
      request_hash,
      operation_ref
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    IF NOT EXISTS;

  APPLY BATCH
`;

export const FENCE_CHAT_REVISION = `
  UPDATE e2e_chat_admission
  SET revision = ?
  WHERE chat_id = ?
    AND entry_key = 'state'
  IF revision = ?
`;
