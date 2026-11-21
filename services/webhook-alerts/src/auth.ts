import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGithub(raw: Uint8Array, signature: string, secret: string): boolean {
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const actual = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(actual, expected);
}
