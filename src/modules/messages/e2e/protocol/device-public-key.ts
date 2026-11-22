export function validDevicePublicKey(
  value: unknown,
  kind: 'signing' | 'identity',
): boolean {
  if (typeof value !== 'string' || value.length !== 44) return false;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return false;
  return kind === 'signing'
    ? bytes.length === 32
    : bytes.length === 33 && bytes[0] === 5;
}
