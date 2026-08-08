import { describe, expect, it } from 'vitest';
import { adminUpdateSettingsRefinedSchema } from './admin.schema.js';
import { loginSchema, registerSchema, resetPasswordSchema } from './auth.schema.js';
import { avatarUrlSchema, birthDateSchema, passwordSchema, usernameSchema } from './primitives.js';
import { updatePreferencesSchema, updateProfileSchema } from './profile.schema.js';
import {
  chatMessageSchema,
  queueJoinSchema,
  webrtcIceSchema,
  webrtcOfferSchema,
} from './realtime.schema.js';
import { createReportSchema, resolveReportRefinedSchema } from './safety.schema.js';

const ZWSP = String.fromCodePoint(0x200b);

/** A registration payload that passes, so each test can vary exactly one field. */
const validRegistration = {
  email: 'Ana@Example.COM',
  username: 'ana_pt',
  password: 'a-strong-passphrase',
  confirmPassword: 'a-strong-passphrase',
  birthDate: '1996-03-15',
  country: 'PT',
  locale: 'pt',
  languages: ['pt', 'en'],
  acceptedTerms: true,
  acceptedGuidelines: true,
};

describe('registration', () => {
  it('accepts a valid payload and normalises the email', () => {
    const result = registerSchema.safeParse(validRegistration);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('ana@example.com');
  });

  it('rejects mismatched password confirmation', () => {
    const result = registerSchema.safeParse({ ...validRegistration, confirmPassword: 'different' });
    expect(result.success).toBe(false);
  });

  it('rejects a password containing the username', () => {
    const result = registerSchema.safeParse({
      ...validRegistration,
      password: 'ana_pt-is-my-password',
      confirmPassword: 'ana_pt-is-my-password',
    });
    expect(result.success).toBe(false);
  });

  /**
   * Terms acceptance is `z.literal(true)`, not `z.boolean()`. Omitting the field or
   * sending `false` must both fail — a client must never be able to register someone
   * without an affirmative record of consent.
   */
  it('requires affirmative acceptance of terms and guidelines', () => {
    expect(registerSchema.safeParse({ ...validRegistration, acceptedTerms: false }).success).toBe(
      false,
    );
    const { acceptedGuidelines: _omitted, ...withoutGuidelines } = validRegistration;
    expect(registerSchema.safeParse(withoutGuidelines).success).toBe(false);
  });

  it('rejects a reserved username', () => {
    for (const username of ['admin', 'moderator', 'trip2world', 'support']) {
      expect(usernameSchema.safeParse(username).success).toBe(false);
    }
  });

  it('rejects usernames with leading or trailing separators', () => {
    expect(usernameSchema.safeParse('_ana').success).toBe(false);
    expect(usernameSchema.safeParse('ana_').success).toBe(false);
    expect(usernameSchema.safeParse('an').success).toBe(false);
    expect(usernameSchema.safeParse('ana').success).toBe(true);
  });
});

describe('age gate', () => {
  it('rejects anyone under the absolute floor of 18', () => {
    const seventeen = new Date();
    seventeen.setUTCFullYear(seventeen.getUTCFullYear() - 17);
    expect(birthDateSchema.safeParse(seventeen.toISOString().slice(0, 10)).success).toBe(false);
  });

  it('accepts someone who turned 18 today', () => {
    const exactly18 = new Date();
    exactly18.setUTCFullYear(exactly18.getUTCFullYear() - 18);
    expect(birthDateSchema.safeParse(exactly18.toISOString().slice(0, 10)).success).toBe(true);
  });

  it('rejects a future date and an impossible one', () => {
    expect(birthDateSchema.safeParse('2999-01-01').success).toBe(false);
    expect(birthDateSchema.safeParse('1800-01-01').success).toBe(false);
    // Not a real calendar date.
    expect(birthDateSchema.safeParse('1996-02-31').success).toBe(false);
  });

  /**
   * Date-only, no timezone. Accepting an offset is how off-by-one-day age-gate bugs
   * happen: a client in UTC+14 could otherwise present a birthday that is "tomorrow"
   * on the server.
   */
  it('rejects a timestamp with a timezone component', () => {
    expect(birthDateSchema.safeParse('1996-03-15T00:00:00Z').success).toBe(false);
    expect(birthDateSchema.safeParse('1996-03-15+14:00').success).toBe(false);
  });
});

describe('password policy', () => {
  it('enforces a length floor and ceiling', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('x'.repeat(200)).success).toBe(false);
  });

  it('rejects passwords from the common-password denylist', () => {
    expect(passwordSchema.safeParse('password123').success).toBe(false);
    expect(passwordSchema.safeParse('Password123').success).toBe(false); // case-insensitive
    expect(passwordSchema.safeParse('trip2world').success).toBe(false);
  });

  it('rejects a long but trivially repetitive password', () => {
    expect(passwordSchema.safeParse('aaaaaaaaaaaaaaa').success).toBe(false);
  });

  it('accepts a long passphrase without demanding symbols', () => {
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });

  /**
   * Login must NOT apply the password policy. An existing password predates any policy
   * change, and rejecting it at login would both lock users out and disclose which
   * accounts have weak passwords.
   */
  it('does not apply the policy to login', () => {
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'weak' }).success).toBe(true);
  });
});

describe('mass assignment', () => {
  /**
   * The profile schema is `.strict()` and simply has no role/plan/status/email field.
   * An attempt to set one is rejected at the boundary rather than relying on the service
   * layer to remember to ignore it.
   */
  it('rejects privilege fields smuggled into a profile update', () => {
    for (const payload of [
      { role: 'SUPER_ADMIN' },
      { plan: 'PREMIUM' },
      { status: 'ACTIVE' },
      { email: 'attacker@example.com' },
      { emailVerified: true },
      { safetyScore: 0 },
      { birthDate: '1990-01-01' },
    ]) {
      const result = updateProfileSchema.safeParse({ displayName: 'Ana', ...payload });
      expect(result.success, `should reject ${JSON.stringify(payload)}`).toBe(false);
    }
  });

  it('accepts a legitimate profile update', () => {
    expect(updateProfileSchema.safeParse({ displayName: 'Ana', country: 'pt' }).success).toBe(true);
  });

  it('rejects unknown fields on a preferences update', () => {
    expect(
      updatePreferencesSchema.safeParse({ preferredGender: 'ANY', priorityQueue: true }).success,
    ).toBe(false);
  });
});

describe('avatar URL (SSRF surface)', () => {
  it('accepts an https URL on a public host', () => {
    expect(avatarUrlSchema.safeParse('https://cdn.example.com/a.png').success).toBe(true);
  });

  it('rejects non-https schemes', () => {
    expect(avatarUrlSchema.safeParse('http://cdn.example.com/a.png').success).toBe(false);
    expect(avatarUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(avatarUrlSchema.safeParse('data:image/png;base64,AAA').success).toBe(false);
    expect(avatarUrlSchema.safeParse('file:///etc/passwd').success).toBe(false);
  });

  it('rejects internal and metadata targets', () => {
    for (const url of [
      'https://localhost/a.png',
      'https://127.0.0.1/a.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/a.png',
      'https://redis.internal/a.png',
      'https://postgres.local/a.png',
      'https://[::1]/a.png',
    ]) {
      expect(avatarUrlSchema.safeParse(url).success, `should reject ${url}`).toBe(false);
    }
  });

  it('rejects embedded credentials', () => {
    expect(avatarUrlSchema.safeParse('https://user:pass@cdn.example.com/a.png').success).toBe(false);
  });
});

describe('WebRTC signaling payloads', () => {
  const matchId = '11111111-1111-4111-8111-111111111111';
  const validSdp = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

  it('accepts a well-formed offer', () => {
    expect(webrtcOfferSchema.safeParse({ matchId, sdp: validSdp, type: 'offer' }).success).toBe(
      true,
    );
  });

  /**
   * Without the `v=0` requirement, the signaling channel is a general-purpose text relay
   * between two strangers — an unmoderated chat that bypasses every safety control.
   */
  it('rejects an SDP that is really arbitrary text', () => {
    expect(
      webrtcOfferSchema.safeParse({ matchId, sdp: 'hey, meet me at...', type: 'offer' }).success,
    ).toBe(false);
  });

  it('caps SDP size so signaling cannot be used for amplification', () => {
    const huge = `v=0\r\n${'a'.repeat(64 * 1024)}`;
    expect(webrtcOfferSchema.safeParse({ matchId, sdp: huge, type: 'offer' }).success).toBe(false);
  });

  it('rejects an answer masquerading as an offer', () => {
    expect(webrtcOfferSchema.safeParse({ matchId, sdp: validSdp, type: 'answer' }).success).toBe(
      false,
    );
  });

  it('requires a valid match id, so a peer cannot inject into another call', () => {
    expect(
      webrtcOfferSchema.safeParse({ matchId: 'not-a-uuid', sdp: validSdp, type: 'offer' }).success,
    ).toBe(false);
  });

  it('accepts the empty end-of-candidates signal but caps candidate length', () => {
    expect(
      webrtcIceSchema.safeParse({
        matchId,
        candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: 0 },
      }).success,
    ).toBe(true);

    expect(
      webrtcIceSchema.safeParse({
        matchId,
        candidate: { candidate: 'a'.repeat(5000), sdpMid: '0', sdpMLineIndex: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('chat messages', () => {
  const matchId = '11111111-1111-4111-8111-111111111111';

  it('strips invisible padding used to defeat the length limit', () => {
    const result = chatMessageSchema.safeParse({
      matchId,
      body: `hi${ZWSP.repeat(40)}there`,
      clientId: 'c1',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.body).toBe('hithere');
  });

  it('rejects a message that is only whitespace or invisible characters', () => {
    expect(chatMessageSchema.safeParse({ matchId, body: '   ', clientId: 'c1' }).success).toBe(
      false,
    );
    expect(
      chatMessageSchema.safeParse({ matchId, body: ZWSP.repeat(10), clientId: 'c1' }).success,
    ).toBe(false);
  });

  it('enforces the length cap', () => {
    expect(
      chatMessageSchema.safeParse({ matchId, body: 'a'.repeat(2000), clientId: 'c1' }).success,
    ).toBe(false);
  });
});

describe('queue join', () => {
  it('accepts session preference overrides', () => {
    expect(
      queueJoinSchema.safeParse({
        hasCamera: true,
        hasMicrophone: true,
        preferences: { preferredGender: 'ANY', preferredCountries: ['DE'] },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown preference keys', () => {
    expect(
      queueJoinSchema.safeParse({
        hasCamera: true,
        hasMicrophone: true,
        preferences: { skipEveryone: true },
      }).success,
    ).toBe(false);
  });

  it('requires explicit media capability flags', () => {
    expect(queueJoinSchema.safeParse({ hasCamera: true }).success).toBe(false);
  });
});

describe('reports', () => {
  const userId = '22222222-2222-4222-8222-222222222222';

  it('defaults to also blocking the reported user', () => {
    const result = createReportSchema.safeParse({ reportedUserId: userId, category: 'HARASSMENT' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.alsoBlock).toBe(true);
  });

  it('rejects an unknown category', () => {
    expect(
      createReportSchema.safeParse({ reportedUserId: userId, category: 'BECAUSE_I_LOST' }).success,
    ).toBe(false);
  });

  it('requires a user-facing reason before restricting an account', () => {
    expect(resolveReportRefinedSchema.safeParse({ reportId: userId, action: 'BAN' }).success).toBe(
      false,
    );
    expect(
      resolveReportRefinedSchema.safeParse({ reportId: userId, action: 'BAN', reason: 'Nudity' })
        .success,
    ).toBe(true);
  });

  it('requires a duration for a suspension, since an indefinite one is a ban', () => {
    expect(
      resolveReportRefinedSchema.safeParse({
        reportId: userId,
        action: 'SUSPEND',
        reason: 'Harassment',
      }).success,
    ).toBe(false);

    expect(
      resolveReportRefinedSchema.safeParse({
        reportId: userId,
        action: 'SUSPEND',
        reason: 'Harassment',
        suspensionHours: 72,
      }).success,
    ).toBe(true);
  });

  it('allows a dismissal without a reason', () => {
    expect(
      resolveReportRefinedSchema.safeParse({ reportId: userId, action: 'DISMISS' }).success,
    ).toBe(true);
  });
});

describe('admin settings', () => {
  it('refuses to lower the age gate below the legal floor', () => {
    expect(adminUpdateSettingsRefinedSchema.safeParse({ minimumAge: 16 }).success).toBe(false);
    expect(adminUpdateSettingsRefinedSchema.safeParse({ minimumAge: 21 }).success).toBe(true);
  });

  /** Out-of-order stages would make later ones unreachable, silently freezing relaxation. */
  it('requires relaxation stages to be strictly increasing', () => {
    const stages = (seconds: number[]) =>
      seconds.map((afterSeconds) => ({ afterSeconds, drop: [], label: `s${afterSeconds}` }));

    const base = {
      maxQueueSeconds: 180,
      skipCooldownSeconds: 1800,
      minSecondsBetweenSkips: 1,
      negotiationTimeoutMs: 20_000,
    };

    expect(
      adminUpdateSettingsRefinedSchema.safeParse({
        matchmaking: { ...base, relaxationStages: stages([0, 5, 15, 30]) },
      }).success,
    ).toBe(true);

    expect(
      adminUpdateSettingsRefinedSchema.safeParse({
        matchmaking: { ...base, relaxationStages: stages([0, 30, 15]) },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown settings keys', () => {
    expect(adminUpdateSettingsRefinedSchema.safeParse({ disableAllModeration: true }).success).toBe(
      false,
    );
  });
});

describe('password reset', () => {
  it('requires the confirmation to match and the policy to hold', () => {
    const token = 'x'.repeat(40);
    expect(
      resetPasswordSchema.safeParse({
        token,
        password: 'a-strong-passphrase',
        confirmPassword: 'a-strong-passphrase',
      }).success,
    ).toBe(true);

    expect(
      resetPasswordSchema.safeParse({ token, password: 'short', confirmPassword: 'short' }).success,
    ).toBe(false);
  });
});
