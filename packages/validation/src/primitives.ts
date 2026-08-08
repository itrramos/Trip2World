import {
  ABSOLUTE_MINIMUM_AGE,
  BIO_MAX_LENGTH,
  CHAT_MESSAGE_MAX_LENGTH,
  COUNTRY_CODES,
  DISPLAY_NAME_MAX_LENGTH,
  INTEREST_SLUGS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RESERVED_USERNAMES,
  sanitizeDisplayText,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from '@trip2world/shared';
import {
  ACCOUNT_STATUSES,
  AGE_BRACKETS,
  GENDER_PREFERENCES,
  GENDERS,
  LOCALES,
  REPORT_CATEGORIES,
  REPORT_STATUSES,
  USER_ROLES,
} from '@trip2world/types';
import { z } from 'zod';

/**
 * Reusable field-level schemas.
 *
 * Every user-supplied value in Trip2World is parsed by one of these before it reaches a
 * service, whether it arrived over HTTP or a WebSocket frame. Free-text fields are
 * *transformed* (trimmed, invisible characters stripped) as part of parsing, so callers
 * cannot forget to sanitise — the parsed value is already clean.
 */

export const uuidSchema = z.string().uuid();

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Enter a valid email address');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN_LENGTH, `Username must be at least ${USERNAME_MIN_LENGTH} characters`)
  .max(USERNAME_MAX_LENGTH, `Username must be at most ${USERNAME_MAX_LENGTH} characters`)
  .regex(
    USERNAME_PATTERN,
    'Use lowercase letters, numbers and underscores; start and end with a letter or number',
  )
  .refine((v) => !RESERVED_USERNAMES.includes(v), 'That username is reserved');

/**
 * Password policy.
 *
 * Length is the dominant factor in resistance to offline cracking, so the floor is 10
 * rather than the more common 8, and there is no composition rule (forced symbols push
 * users toward predictable substitutions). A small denylist catches the passwords that
 * appear in every credential-stuffing list; anything more is the job of a breach-corpus
 * check, which the API performs when one is configured.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'letmein123', 'iloveyou1', 'trip2world', 'welcome123', 'admin12345',
]);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'That password is too common')
  .refine((v) => new Set(v).size >= 4, 'That password is too repetitive');

/** Free text that a human will read. Sanitised during parsing. */
export function displayTextSchema(max: number) {
  return z
    .string()
    .max(max * 2, 'Too long') // pre-sanitisation guard against pathological input
    .transform(sanitizeDisplayText)
    .pipe(z.string().max(max, `Must be at most ${max} characters`));
}

export const displayNameSchema = displayTextSchema(DISPLAY_NAME_MAX_LENGTH);
export const bioSchema = displayTextSchema(BIO_MAX_LENGTH);
/** The body of a chat message. Named `chatBody` to leave `chatMessageSchema` for the
 *  full realtime event payload in `realtime.schema.ts`. */
export const chatBodySchema = displayTextSchema(CHAT_MESSAGE_MAX_LENGTH).pipe(
  z.string().min(1, 'Message cannot be empty'),
);

export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(2)
  .refine((v) => COUNTRY_CODES.includes(v), 'Unsupported country');

export const languageCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2}$/, 'Use a two-letter language code');

export const localeSchema = z.enum(LOCALES as [string, ...string[]]);
export const genderSchema = z.enum(GENDERS as [string, ...string[]]);
export const genderPreferenceSchema = z.enum(GENDER_PREFERENCES as [string, ...string[]]);
export const ageBracketSchema = z.enum(AGE_BRACKETS as [string, ...string[]]);
export const reportCategorySchema = z.enum(REPORT_CATEGORIES as [string, ...string[]]);
export const reportStatusSchema = z.enum(REPORT_STATUSES as [string, ...string[]]);
export const accountStatusSchema = z.enum(ACCOUNT_STATUSES as [string, ...string[]]);
export const userRoleSchema = z.enum(USER_ROLES as [string, ...string[]]);

export const interestSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => INTEREST_SLUGS.includes(v), 'Unknown interest');

/**
 * Date of birth.
 *
 * Accepts `YYYY-MM-DD` only — no timezone component, because a birthday is a calendar
 * date rather than an instant, and letting a client send an offset is how off-by-one-day
 * age-gate bugs happen. The hard floor of `ABSOLUTE_MINIMUM_AGE` is enforced here as
 * defence in depth; the operator-configured minimum is applied again in the service layer
 * and may be higher, never lower.
 */
export const birthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Enter a real date')
  .refine((v) => new Date(`${v}T00:00:00.000Z`) <= new Date(), 'Date of birth cannot be in the future')
  .refine((v) => {
    const dob = new Date(`${v}T00:00:00.000Z`);
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - ABSOLUTE_MINIMUM_AGE);
    return dob <= cutoff;
  }, `You must be at least ${ABSOLUTE_MINIMUM_AGE} to use Trip2World`)
  .refine((v) => {
    const dob = new Date(`${v}T00:00:00.000Z`);
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 120);
    return dob >= cutoff;
  }, 'Enter a real date of birth');

/**
 * Avatar URL.
 *
 * Restricted to https and to hosts without credentials so a stored profile can never be
 * used to point the server or another client at an internal address (SSRF) or to smuggle
 * a `javascript:` payload into an `<img src>`.
 */
export const avatarUrlSchema = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((v) => {
    try {
      const url = new URL(v);
      if (url.protocol !== 'https:') return false;
      if (url.username || url.password) return false;
      const host = url.hostname.toLowerCase();
      // Block obvious internal targets. The API additionally resolves and re-checks.
      const blocked =
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.internal') ||
        host.endsWith('.local') ||
        /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
        host.startsWith('[');
      return !blocked;
    } catch {
      return false;
    }
  }, 'Avatar must be an https URL on a public host');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Re-exported so callers validating free text do not need a second import. */
export { sanitizeDisplayText };
