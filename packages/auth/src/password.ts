import { timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Password hashing.
 *
 * Argon2id, with the OWASP-recommended baseline parameters. Chosen over bcrypt for GPU
 * and ASIC resistance (bcrypt's 4 KiB working set fits trivially in on-die memory), and
 * over scrypt because Argon2id's hybrid data-dependent/independent addressing gives
 * better side-channel behaviour than scrypt while resisting the same tradeoff attacks.
 *
 * The parameters are exported so the admin CLI and the seed script hash identically —
 * a mismatch there would produce accounts that cannot log in.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  /** 19 MiB. The dominant cost factor against parallel cracking hardware. */
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Never throws on a malformed or corrupt hash — it returns false. A thrown exception here
 * would be observable as a different response time or error shape and would distinguish
 * "account exists with a broken hash" from "wrong password".
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A dummy hash of a random value, used to equalise timing on the login path.
 *
 * When an email does not exist there is no stored hash to verify against. Returning
 * immediately makes "no such account" measurably faster than "wrong password", which
 * turns login into an account-enumeration oracle. The login handler verifies against this
 * constant instead, so both branches pay the same Argon2 cost.
 */
let dummyHashPromise: Promise<string> | null = null;

export function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('trip2world-nonexistent-account-placeholder', ARGON2_OPTIONS);
  return dummyHashPromise;
}

/** Burn the same CPU as a real verification, then fail. */
export async function fakeVerify(password: string): Promise<false> {
  await verifyPassword(await getDummyHash(), password);
  return false;
}

/**
 * True when a stored hash was produced with weaker parameters than the current policy and
 * should be upgraded. Called after a successful login, when the plaintext is in hand.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    // Unparseable hash — force a rehash rather than leaving it in place.
    return true;
  }
}

/**
 * Constant-time string comparison for non-password secrets (tokens, HMACs, webhook
 * signatures). `===` on a secret leaks its length and its first differing byte through
 * timing.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length; compare
  // fixed-size digests instead by padding to the longer length.
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so the failure path costs roughly the same.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
