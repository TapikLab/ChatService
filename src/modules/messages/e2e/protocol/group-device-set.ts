import { createHash } from 'node:crypto';

export function computeGroupDeviceSetHash(
  chatId: string,
  membershipVaersion: number,
  rosters: readonly { readonly userId: string; readonly rosterHash: string }[],
): string {
  const ordered = [...rosters].sort((a, b) =>
    a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
  );

  const seralized = JSON.stringify([
    'tapik.group.device-set.v1',
    chatId,
    membershipVaersion,
    ordered.map((roster) => [roster.userId, roster.rosterHash]),
  ]);

  return createHash('sha256').update(seralized, 'utf8').digest('hex');
}
