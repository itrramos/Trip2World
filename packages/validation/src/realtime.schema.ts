import { CHAT_MESSAGE_MAX_LENGTH } from '@trip2world/shared';
import { z } from 'zod';
import {
  ageBracketSchema,
  countryCodeSchema,
  displayTextSchema,
  genderPreferenceSchema,
  interestSlugSchema,
  languageCodeSchema,
  reportCategorySchema,
  uuidSchema,
} from './primitives.js';

/**
 * Runtime validation for the realtime protocol.
 *
 * The TypeScript types in `@trip2world/types` describe the contract; these schemas are
 * what actually enforces it. A WebSocket frame is attacker-controlled input exactly like
 * an HTTP body, and the realtime server rejects any frame that does not parse — there is
 * no "trusted because it is on an authenticated socket" path.
 *
 * Size limits matter as much as shape here: SDP and ICE payloads are relayed to another
 * user, so an unbounded string would be an amplification primitive.
 */

/** Largest SDP we will relay. Real offers are a few KB; 32 KB is generous headroom. */
const MAX_SDP_LENGTH = 32 * 1024;
const MAX_ICE_CANDIDATE_LENGTH = 1024;

/**
 * SDP sanity check.
 *
 * We do not attempt to fully parse SDP — that is the browser's job and a partial parser
 * would be its own attack surface. We do require it to *look* like SDP (start with the
 * mandatory `v=0` line) so the signaling channel cannot be trivially repurposed to relay
 * arbitrary text between users, which would turn it into an unmoderated chat.
 */
const sdpSchema = z
  .string()
  .min(1)
  .max(MAX_SDP_LENGTH, 'SDP too large')
  .refine((v) => v.startsWith('v=0'), 'Malformed SDP');

export const webrtcOfferSchema = z.object({
  matchId: uuidSchema,
  sdp: sdpSchema,
  type: z.literal('offer'),
});

export const webrtcAnswerSchema = z.object({
  matchId: uuidSchema,
  sdp: sdpSchema,
  type: z.literal('answer'),
});

export const webrtcIceSchema = z.object({
  matchId: uuidSchema,
  candidate: z.object({
    /** An empty string is the legitimate end-of-candidates signal. */
    candidate: z.string().max(MAX_ICE_CANDIDATE_LENGTH),
    sdpMid: z.string().max(64).nullable(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable(),
    usernameFragment: z.string().max(256).nullable().optional(),
  }),
});

export const iceServersRequestSchema = z.object({ matchId: uuidSchema });

/* --- Queue ---------------------------------------------------------------- */

/** Per-session preference overrides. Persisted preferences are the fallback. */
const sessionPreferencesSchema = z
  .object({
    preferredGender: genderPreferenceSchema.optional(),
    preferredCountries: z.array(countryCodeSchema).max(20).optional(),
    preferredLanguages: z.array(languageCodeSchema).max(5).optional(),
    preferredAgeBrackets: z.array(ageBracketSchema).max(5).optional(),
    interestIds: z.array(interestSlugSchema).max(10).optional(),
    autoRequeue: z.boolean().optional(),
    startMuted: z.boolean().optional(),
    startCameraOff: z.boolean().optional(),
  })
  .strict();

export const queueJoinSchema = z.object({
  preferences: sessionPreferencesSchema.optional(),
  /**
   * Self-reported media availability. A client with neither camera nor microphone is
   * refused: joining the queue without media wastes a real person's turn on a silent
   * black rectangle. The server cannot verify this claim, so it is a UX guard, not a
   * security control.
   */
  hasCamera: z.boolean(),
  hasMicrophone: z.boolean(),
});
export type QueueJoinInput = z.infer<typeof queueJoinSchema>;

export const matchSkipSchema = z.object({
  matchId: uuidSchema,
  requeue: z.boolean().default(true),
});

export const matchEndSchema = z.object({ matchId: uuidSchema });

export const matchConnectedSchema = z.object({ matchId: uuidSchema });

/* --- Chat ----------------------------------------------------------------- */

export const chatMessageSchema = z.object({
  matchId: uuidSchema,
  body: displayTextSchema(CHAT_MESSAGE_MAX_LENGTH).pipe(z.string().min(1, 'Message is empty')),
  /** Client-generated so the sender can reconcile its optimistic bubble. */
  clientId: z.string().min(1).max(64),
});

/* --- Safety --------------------------------------------------------------- */

export const socketReportSchema = z.object({
  matchId: uuidSchema.nullable(),
  reportedUserId: uuidSchema,
  category: reportCategorySchema,
  details: displayTextSchema(1000).optional(),
  alsoBlock: z.boolean().default(true),
});

export const socketBlockSchema = z.object({
  userId: uuidSchema,
  matchId: uuidSchema.nullable().default(null),
});

/* --- Telemetry ------------------------------------------------------------ */

export const connectionStatsSchema = z.object({
  matchId: uuidSchema,
  stats: z.object({
    quality: z.enum(['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'UNKNOWN']),
    roundTripTimeMs: z.number().min(0).max(60_000).nullable(),
    packetsLostPct: z.number().min(0).max(100).nullable(),
    candidateType: z.enum(['host', 'srflx', 'prflx', 'relay']).nullable(),
  }),
});

export const presenceOnlineSchema = z.object({
  state: z.enum(['ONLINE', 'MATCHING', 'CONNECTED', 'AWAY']),
});

/**
 * Lookup table used by the realtime server's generic event guard, so adding an event
 * without a schema is a compile error rather than an unvalidated hole.
 */
export const REALTIME_EVENT_SCHEMAS = {
  'presence:online': presenceOnlineSchema,
  'queue:join': queueJoinSchema,
  'match:skip': matchSkipSchema,
  'match:end': matchEndSchema,
  'match:connected': matchConnectedSchema,
  'webrtc:offer': webrtcOfferSchema,
  'webrtc:answer': webrtcAnswerSchema,
  'webrtc:ice': webrtcIceSchema,
  'webrtc:ice-servers': iceServersRequestSchema,
  'chat:message': chatMessageSchema,
  'user:report': socketReportSchema,
  'user:block': socketBlockSchema,
  'stats:report': connectionStatsSchema,
} as const;

export type RealtimeEventName = keyof typeof REALTIME_EVENT_SCHEMAS;
