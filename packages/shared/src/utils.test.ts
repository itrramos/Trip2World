import { ConnectionQuality } from '@trip2world/types';
import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  clamp,
  deriveConnectionQuality,
  formatDuration,
  hashString,
  intersect,
  isInRollout,
  maskEmail,
  normalizeWhitespace,
  sanitizeDisplayText,
  stripInvisibleCharacters,
  unique,
} from './utils.js';

/** Named so the test source itself stays free of literal invisible characters. */
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const BOM = String.fromCodePoint(0xfeff);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const NUL = String.fromCodePoint(0x0000);
const WORD_JOINER = String.fromCodePoint(0x2060);

describe('stripInvisibleCharacters', () => {
  it('removes the zero-width family used to pad past length checks', () => {
    expect(stripInvisibleCharacters(`a${ZWSP}b${BOM}c${SOFT_HYPHEN}d${WORD_JOINER}e`)).toBe('abcde');
  });

  it('removes bidi overrides used to spoof surrounding UI text', () => {
    expect(stripInvisibleCharacters(`admin${RLO}evil`)).toBe('adminevil');
  });

  it('removes control characters that would corrupt logs', () => {
    expect(stripInvisibleCharacters(`ok${NUL}fine`)).toBe('okfine');
  });

  it('leaves ordinary text, accents, emoji and CJK untouched', () => {
    expect(stripInvisibleCharacters('Ana Sofia — 日本語 🎧')).toBe('Ana Sofia — 日本語 🎧');
  });

  it('does not corrupt surrogate pairs', () => {
    const emoji = '👩‍🚀';
    // The ZWJ inside the sequence is U+200D, which we deliberately strip; the component
    // code points must survive intact rather than becoming lone surrogates.
    const result = stripInvisibleCharacters(emoji);
    expect([...result].every((c) => c.codePointAt(0)! > 0xffff)).toBe(true);
  });
});

describe('sanitizeDisplayText', () => {
  it('collapses whitespace and trims', () => {
    expect(sanitizeDisplayText('  Ana   Sofia  ')).toBe('Ana Sofia');
  });

  it('defeats a padded name that would otherwise pass a length check', () => {
    const padded = `ab${ZWSP.repeat(50)}cd`;
    expect(sanitizeDisplayText(padded)).toBe('abcd');
  });

  it('can reduce a string of only invisible characters to empty', () => {
    expect(sanitizeDisplayText(ZWSP.repeat(10))).toBe('');
  });
});

describe('normalizeWhitespace', () => {
  it('collapses newlines and tabs into single spaces', () => {
    expect(normalizeWhitespace('a\n\nb\t\tc')).toBe('a b c');
  });
});

describe('deriveConnectionQuality', () => {
  it('returns UNKNOWN before any stats have arrived', () => {
    expect(deriveConnectionQuality(null, null)).toBe(ConnectionQuality.UNKNOWN);
  });

  it('grades on the worse of latency and loss', () => {
    expect(deriveConnectionQuality(40, 0)).toBe(ConnectionQuality.EXCELLENT);
    expect(deriveConnectionQuality(150, 0)).toBe(ConnectionQuality.GOOD);
    expect(deriveConnectionQuality(300, 0)).toBe(ConnectionQuality.FAIR);
    expect(deriveConnectionQuality(500, 0)).toBe(ConnectionQuality.POOR);
    // Low latency does not rescue heavy loss.
    expect(deriveConnectionQuality(20, 10)).toBe(ConnectionQuality.POOR);
  });
});

describe('formatDuration', () => {
  it('formats minutes and seconds, adding hours only when needed', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('never renders a negative duration', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('rollout bucketing', () => {
  it('is stable for the same flag and user', () => {
    const a = isInRollout('new-ui', 'user-1', 50);
    for (let i = 0; i < 20; i += 1) expect(isInRollout('new-ui', 'user-1', 50)).toBe(a);
  });

  it('honours the 0 and 100 boundaries absolutely', () => {
    expect(isInRollout('f', 'user-1', 0)).toBe(false);
    expect(isInRollout('f', 'user-1', 100)).toBe(true);
  });

  it('lands roughly on the requested percentage across many users', () => {
    const total = 5000;
    let included = 0;
    for (let i = 0; i < total; i += 1) if (isInRollout('flag', `user-${i}`, 30)) included += 1;
    expect(included / total).toBeGreaterThan(0.26);
    expect(included / total).toBeLessThan(0.34);
  });

  it('buckets the same user differently for different flags', () => {
    const perFlag = ['a', 'b', 'c', 'd', 'e'].map((f) => hashString(`${f}:user-1`) % 100);
    expect(new Set(perFlag).size).toBeGreaterThan(1);
  });
});

describe('backoffDelay', () => {
  it('stays within the jittered ceiling and respects the cap', () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delay = backoffDelay(attempt, 500, 15_000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(15_000);
    }
  });
});

describe('misc helpers', () => {
  it('clamps into range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it('intersects case-insensitively', () => {
    expect(intersect(['EN', 'pt'], ['en', 'de'])).toEqual(['EN']);
  });

  it('dedupes preserving order', () => {
    expect(unique([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });

  it('masks emails without revealing the local part', () => {
    expect(maskEmail('ana@example.com')).toBe('an*@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
