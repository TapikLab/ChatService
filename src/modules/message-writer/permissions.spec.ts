const policy = require('../../../scripts/epic04-migrate.cjs') as {
  protectedTables: string[];
  mutableTables: string[];
  permissions: (keyspace: string, chat: string, writer: string) => string[];
  reactionPermissions: (keyspace: string, role: string) => string[];
  identifier: (value: string) => string;
  literal: (value: string) => string;
};

describe('writer permission manifest', () => {
  const queries = policy.permissions(
    'chat_alpha_messages',
    'tapik_chat_v04',
    'tapik_writer_v04',
  );
  it.each(policy.protectedTables)(
    'grants ChatService only SELECT on %s',
    (table) => {
      const grants = queries.filter((q) =>
        q.includes(`.${table} TO tapik_chat_v04`),
      );
      expect(grants).toEqual([
        `GRANT SELECT ON TABLE chat_alpha_messages.${table} TO tapik_chat_v04`,
      ]);
    },
  );
  it.each(policy.protectedTables)(
    'grants writer SELECT and MODIFY on %s',
    (table) => {
      expect(
        queries.filter((q) => q.includes(`.${table} TO tapik_writer_v04`)),
      ).toEqual([
        `GRANT SELECT ON TABLE chat_alpha_messages.${table} TO tapik_writer_v04`,
        `GRANT MODIFY ON TABLE chat_alpha_messages.${table} TO tapik_writer_v04`,
      ]);
    },
  );
  it('does not grant schema or role administration', () => {
    expect(queries.join('\n')).not.toMatch(
      /GRANT (ALL|ALTER|DROP|CREATE|AUTHORIZE)|ON KEYSPACE|ON ALL/,
    );
  });
  it('keeps membership mutation outside the writer', () => {
    expect(
      queries.filter(
        (q) => q.endsWith('TO tapik_writer_v04') && q.includes('.chat_members'),
      ),
    ).toEqual([
      'GRANT SELECT ON TABLE chat_alpha_messages.chat_members TO tapik_writer_v04',
    ]);
  });
  it('rejects identifier injection and escapes password quotes', () => {
    expect(() => policy.identifier('keyspace;DROP')).toThrow(
      'INVALID_CQL_IDENTIFIER',
    );
    expect(policy.literal('x'.repeat(32) + "'suffix")).toBe(
      "'" + 'x'.repeat(32) + "''suffix'",
    );
  });
  it('gives ReactionsService access only to its own table', () => {
    expect(
      policy.reactionPermissions('chat_alpha_reactions', 'tapik_reactions_v04'),
    ).toEqual([
      'GRANT SELECT ON TABLE chat_alpha_reactions.message_reactions TO tapik_reactions_v04',
      'GRANT MODIFY ON TABLE chat_alpha_reactions.message_reactions TO tapik_reactions_v04',
    ]);
  });
});
