import { ConnectionQuality } from '@trip2world/types';

/** Small isomorphic helpers shared by every app. No Node or DOM globals in here. */

/** Clamp `value` into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** `mm:ss` (or `h:mm:ss`) for a duration in seconds. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Bucket live WebRTC stats into a quality badge.
 *
 * Thresholds are tuned for one-to-one video: past ~250 ms RTT or ~4 % loss a conversation
 * stops feeling real-time, which is the point at which we want to warn the user rather
 * than let them assume the other person is being rude.
 */
export function deriveConnectionQuality(
  roundTripTimeMs: number | null,
  packetsLostPct: number | null,
): ConnectionQuality {
  if (roundTripTimeMs === null && packetsLostPct === null) return ConnectionQuality.UNKNOWN;

  const rtt = roundTripTimeMs ?? 0;
  const loss = packetsLostPct ?? 0;

  if (rtt > 400 || loss > 8) return ConnectionQuality.POOR;
  if (rtt > 250 || loss > 4) return ConnectionQuality.FAIR;
  if (rtt > 120 || loss > 1.5) return ConnectionQuality.GOOD;
  return ConnectionQuality.EXCELLENT;
}

/** Deterministic 32-bit FNV-1a hash. Used for feature-flag bucketing, never for security. */
export function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Stable per-user rollout bucketing.
 *
 * The same (flagKey, userId) pair always lands in the same bucket, so a user does not
 * flip in and out of a partial rollout between requests or between services.
 */
export function isInRollout(flagKey: string, userId: string, percentage: number): boolean {
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;
  return hashString(`${flagKey}:${userId}`) % 100 < percentage;
}

/** Case-insensitive, order-independent intersection of two string lists. */
export function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b.map((v) => v.toLowerCase()));
  return a.filter((v) => set.has(v.toLowerCase()));
}

/** Remove duplicates while preserving first-seen order. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (rather than a fixed multiplier) matters here because a realtime node
 * restart disconnects every client at once; without randomisation they would all retry in
 * lockstep and re-create the thundering herd on each attempt.
 */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 15_000): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** Collapse whitespace and trim. Applied to every free-text field before storage. */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Code point ranges removed from all user-authored display text.
 *
 * They are invisible when rendered but load-bearing for abuse:
 *   - C0/C1 controls and DEL corrupt logs and terminal output.
 *   - Soft hyphen and the zero-width family pad a string past a length check while
 *     looking short, and can split a slur to defeat text moderation.
 *   - Bidi embedding/override can visually reverse the text around a name to spoof UI
 *     chrome, e.g. making a display name appear to be a system label.
 *
 * None have a legitimate use in a username, display name, bio, or chat message.
 */
const INVISIBLE_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL + C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x200b, 0x200f], // zero-width space/non-joiner/joiner, LTR/RTL marks
  [0x202a, 0x202e], // bidi embedding and override
  [0x2060, 0x206f], // word joiner, invisible operators, deprecated formatting
  [0xfeff, 0xfeff], // zero-width no-break space (BOM)
];

/**
 * Assembled from the numeric ranges above rather than written as a literal character
 * class, so this source file stays free of the very characters it strips. A literal NUL
 * or bidi override here would be invisible in code review and unsearchable by grep.
 */
const INVISIBLE_CHARACTERS = new RegExp(
  `[${INVISIBLE_CODE_POINT_RANGES.map(([from, to]) => {
    const hex = (n: number) => `\\u{${n.toString(16).padStart(4, '0')}}`;
    return from === to ? hex(from) : `${hex(from)}-${hex(to)}`;
  }).join('')}]`,
  'gu',
);

export function stripInvisibleCharacters(value: string): string {
  return value.replace(INVISIBLE_CHARACTERS, '');
}

/** Full sanitisation pass for user-authored display text. */
export function sanitizeDisplayText(value: string): string {
  return normalizeWhitespace(stripInvisibleCharacters(value));
}

/** Mask an email for display in logs and admin UIs: `an***@example.com`. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/** Type guard that narrows `unknown` to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
