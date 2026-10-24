import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(raw: Uint8Array, signature: string, secret: string, algorithm: 'sha256' | 'sha1'): boolean {
  const hexLength = algorithm === 'sha256' ? 64 : 40;
  if (!new RegExp(`^${algorithm}=[a-fA-F0-9]{${hexLength}}$`).test(signature)) return false;
  const actual = Buffer.from(signature.slice(algorithm.length + 1), 'hex');
  const expected = createHmac(algorithm, secret).update(raw).digest();
  return timingSafeEqual(actual, expected);
}

export function verifyGithub(raw: Uint8Array, signature: string, secret: string): boolean {
  return verify(raw, signature, secret, 'sha256');
}

export function verifyApidog(raw: Uint8Array, signature: string, secret: string): boolean {
  return verify(raw, signature, secret, 'sha1');
}
