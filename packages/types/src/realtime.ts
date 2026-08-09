import type {
  ChatMessage,
  ConnectionStats,
  ISODateString,
  MatchFoundPayload,
  MatchPreferences,
  PublicProfile,
  QueueStatus,
  UUID,
} from './domain.js';
import type { MatchEndReason, PresenceState, ReportCategory } from './enums.js';

/**
 * Trip2World realtime wire protocol.
 *
 * Both directions are fully typed and — critically — every inbound payload is *also*
 * validated at runtime by the matching Zod schema in `@trip2world/validation`. The types
 * here describe the contract; they are not a security boundary on their own.
 */

/** Namespace all realtime traffic lives on. */
export const REALTIME_NAMESPACE = '/rt';

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const RealtimeErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_IN_MATCH: 'NOT_IN_MATCH',
  ALREADY_QUEUED: 'ALREADY_QUEUED',
  ALREADY_MATCHED: 'ALREADY_MATCHED',
  QUEUE_UNAVAILABLE: 'QUEUE_UNAVAILABLE',
  MAINTENANCE: 'MAINTENANCE',
  SKIP_COOLDOWN: 'SKIP_COOLDOWN',
  INTERNAL: 'INTERNAL',
} as const;
export type RealtimeErrorCode = (typeof RealtimeErrorCode)[keyof typeof RealtimeErrorCode];

export interface RealtimeError {
  code: RealtimeErrorCode;
  message: string;
  /** Present on RATE_LIMITED / SKIP_COOLDOWN so the client can show a countdown. */
  retryAfterMs?: number;
  /** Echoes the client event that caused the failure. */
  event?: string;
}

/* -------------------------------------------------------------------------- */
/* Client → Server                                                             */
/* -------------------------------------------------------------------------- */

export interface QueueJoinPayload {
  /** Per-session overrides layered on top of the persisted preferences. */
  preferences?: Partial<MatchPreferences>;
  /** Client-reported media readiness. A client without media cannot be matched. */
  hasCamera: boolean;
  hasMicrophone: boolean;
}

export interface WebRtcOfferPayload {
  matchId: UUID;
  sdp: string;
  type: 'offer';
}

export interface WebRtcAnswerPayload {
  matchId: UUID;
  sdp: string;
  type: 'answer';
}

export interface WebRtcIcePayload {
  matchId: UUID;
  candidate: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment?: string | null;
  };
}

export interface ChatSendPayload {
  matchId: UUID;
  body: string;
  /** Client-generated id so the sender can reconcile the optimistic bubble. */
  clientId: string;
}

export interface MatchSkipPayload {
  matchId: UUID;
  /** Skip and immediately re-enter the queue. */
  requeue: boolean;
}

export interface MatchEndPayload {
  matchId: UUID;
}

export interface ReportPayload {
  matchId: UUID | null;
  reportedUserId: UUID;
  category: ReportCategory;
  details?: string;
  alsoBlock: boolean;
}

export interface BlockPayload {
  userId: UUID;
  matchId: UUID | null;
}

export interface ConnectionStatsPayload {
  matchId: UUID;
  stats: ConnectionStats;
}

/* --- Tipping --------------------------------------------------------------- */

export interface TipSendPayload {
  matchId: UUID;
  tokens: number;
  message?: string;
  /**
   * Extra call time being offered. The recipient may accept or decline; the tokens
   * transfer either way. Omit for a plain tip.
   */
  offeredSeconds?: number;
}

export interface TipReceivedPayload {
  tipId: UUID;
  matchId: UUID;
  fromUserId: UUID;
  /** Display name of the sender, already privacy-filtered. */
  fromName: string;
  tokens: number;
  message: string | null;
  offeredSeconds: number | null;
  /** True on the sender's own copy, so one event can drive both sides of the UI. */
  isOwn: boolean;
  sentAt: ISODateString;
}

export interface TipOfferResponsePayload {
  tipId: UUID;
  accepted: boolean;
}

export interface TipOfferResolvedPayload {
  tipId: UUID;
  accepted: boolean;
  /** Seconds added to the call when accepted. */
  extendedBySeconds: number | null;
}

/** Acknowledgement callback shape used by request/response style events. */
export type Ack<T> = (result: { ok: true; data: T } | { ok: false; error: RealtimeError }) => void;

export interface ClientToServerEvents {
  'presence:online': (payload: { state: Exclude<PresenceState, 'OFFLINE'> }) => void;
  'presence:heartbeat': () => void;

  'queue:join': (payload: QueueJoinPayload, ack?: Ack<{ queued: true }>) => void;
  'queue:leave': (ack?: Ack<{ left: true }>) => void;

  'match:skip': (payload: MatchSkipPayload, ack?: Ack<{ skipped: true }>) => void;
  'match:end': (payload: MatchEndPayload, ack?: Ack<{ ended: true }>) => void;
  /** Client confirms its RTCPeerConnection reached `connected`. Ends the negotiation timer. */
  'match:connected': (payload: { matchId: UUID }) => void;

  'webrtc:offer': (payload: WebRtcOfferPayload) => void;
  'webrtc:answer': (payload: WebRtcAnswerPayload) => void;
  'webrtc:ice': (payload: WebRtcIcePayload) => void;
  /** Ask for a fresh short-lived TURN credential mid-session (e.g. after an ICE restart). */
  'webrtc:ice-servers': (payload: { matchId: UUID }, ack: Ack<{ iceServers: unknown[] }>) => void;

  'chat:message': (payload: ChatSendPayload, ack?: Ack<{ id: UUID; sentAt: string }>) => void;

  'user:report': (payload: ReportPayload, ack?: Ack<{ reportId: UUID }>) => void;
  'user:block': (payload: BlockPayload, ack?: Ack<{ blocked: true }>) => void;

  'tip:send': (payload: TipSendPayload, ack?: Ack<{ tipId: UUID; balance: number }>) => void;
  /** Recipient's answer to a time offer. Only the recipient may send this. */
  'tip:respond': (payload: TipOfferResponsePayload, ack?: Ack<{ ok: true }>) => void;

  'stats:report': (payload: ConnectionStatsPayload) => void;
}

/* -------------------------------------------------------------------------- */
/* Server → Client                                                             */
/* -------------------------------------------------------------------------- */

export interface MatchEndedPayload {
  matchId: UUID;
  reason: MatchEndReason;
  /** True when the server has already put this client back into the queue. */
  requeued: boolean;
}

export interface PartnerLeftPayload {
  matchId: UUID;
  reason: MatchEndReason;
}

export interface ServerToClientEvents {
  ready: (payload: { userId: UUID; nodeId: string; serverTime: string }) => void;

  'queue:joined': (payload: { joinedAt: string }) => void;
  'queue:waiting': (payload: QueueStatus) => void;
  'queue:left': () => void;

  'match:found': (payload: MatchFoundPayload) => void;
  'match:ended': (payload: MatchEndedPayload) => void;
  'match:partner-left': (payload: PartnerLeftPayload) => void;
  /** Partner toggled their camera or microphone. */
  'match:partner-media': (payload: {
    matchId: UUID;
    cameraEnabled: boolean;
    microphoneEnabled: boolean;
  }) => void;

  'webrtc:offer': (payload: WebRtcOfferPayload) => void;
  'webrtc:answer': (payload: WebRtcAnswerPayload) => void;
  'webrtc:ice': (payload: WebRtcIcePayload) => void;

  'chat:message': (payload: ChatMessage & { clientId?: string }) => void;

  'tip:received': (payload: TipReceivedPayload) => void;
  'tip:offer-resolved': (payload: TipOfferResolvedPayload) => void;
  /** Pushed to a user whenever their balance changes, so the header stays accurate. */
  'tokens:balance': (payload: { balance: number }) => void;

  'presence:update': (payload: { userId: UUID; state: PresenceState }) => void;

  'connection:request': (payload: { requestId: UUID; from: PublicProfile }) => void;

  /** Account was restricted mid-session; the client must tear down and show the notice. */
  'account:restricted': (payload: { status: 'SUSPENDED' | 'BANNED'; reason: string }) => void;

  /** Node is shutting down; clients should reconnect (Socket.IO does this automatically). */
  'server:draining': (payload: { retryAfterMs: number }) => void;

  error: (payload: RealtimeError) => void;
}

/** Data attached to each authenticated socket, server-side only. */
export interface SocketData {
  userId: UUID;
  username: string;
  role: string;
  plan: string;
  /** Set once the socket is inside a live match. */
  matchId: UUID | null;
  /** Realtime node that owns this socket. */
  nodeId: string;
  connectedAt: number;
}

/** Inter-node events carried over the Redis adapter. */
export interface InterServerEvents {
  'node:ping': (nodeId: string) => void;
}
