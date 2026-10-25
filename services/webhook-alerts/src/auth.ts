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
  if (signature.startsWith('sha1=')) return verify(raw, signature, secret, 'sha1');
  if (!/^[A-Za-z0-9+/]{27}=$/.test(signature)) return false;
  const actual = Buffer.from(signature, 'base64');
  if (actual.length !== 20 || actual.toString('base64') !== signature) return false;
  const expected = createHmac('sha1', secret).update(raw).digest();
  return timingSafeEqual(actual, expected);
}
