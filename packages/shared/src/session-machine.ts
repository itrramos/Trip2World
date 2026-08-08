import { SessionState } from '@trip2world/types';

/**
 * Conversation session state machine.
 *
 * The video-chat UI is driven entirely by this machine so impossible screens cannot be
 * rendered: there is no "connected but still searching" or "in a match with no peer".
 * Every transition the client performs goes through `transition()`, which refuses illegal
 * moves instead of silently corrupting state.
 *
 * Transitions to ERROR and IDLE are always legal — a fatal failure or a user walking away
 * can happen from anywhere.
 */

const ALWAYS_ALLOWED: readonly SessionState[] = [SessionState.ERROR, SessionState.IDLE];

/** Legal forward transitions, excluding the universally-allowed ERROR/IDLE escapes. */
const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  [SessionState.IDLE]: [SessionState.REQUESTING_PERMISSIONS, SessionState.READY],

  [SessionState.REQUESTING_PERMISSIONS]: [SessionState.READY],

  [SessionState.READY]: [SessionState.QUEUED, SessionState.REQUESTING_PERMISSIONS],

  [SessionState.QUEUED]: [SessionState.MATCH_FOUND, SessionState.READY],

  // A match can be aborted before signaling starts (partner vanished, negotiation refused).
  [SessionState.MATCH_FOUND]: [SessionState.SIGNALING, SessionState.QUEUED, SessionState.READY],

  [SessionState.SIGNALING]: [
    SessionState.CONNECTING,
    SessionState.PARTNER_LEFT,
    SessionState.SKIPPING,
    SessionState.QUEUED,
    SessionState.READY,
  ],

  [SessionState.CONNECTING]: [
    SessionState.CONNECTED,
    SessionState.RECONNECTING,
    SessionState.PARTNER_LEFT,
    SessionState.SKIPPING,
    SessionState.QUEUED,
    SessionState.READY,
  ],

  [SessionState.CONNECTED]: [
    SessionState.SKIPPING,
    SessionState.PARTNER_LEFT,
    SessionState.RECONNECTING,
    SessionState.READY,
  ],

  [SessionState.PARTNER_LEFT]: [SessionState.QUEUED, SessionState.READY],

  [SessionState.SKIPPING]: [SessionState.QUEUED, SessionState.READY],

  // A bounded reconnect either recovers the same peer connection or gives up and requeues.
  [SessionState.RECONNECTING]: [
    SessionState.CONNECTED,
    SessionState.PARTNER_LEFT,
    SessionState.QUEUED,
    SessionState.READY,
  ],

  [SessionState.ERROR]: [SessionState.READY, SessionState.REQUESTING_PERMISSIONS],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  if (from === to) return true;
  if (ALWAYS_ALLOWED.includes(to)) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class InvalidSessionTransitionError extends Error {
  constructor(
    public readonly from: SessionState,
    public readonly to: SessionState,
  ) {
    super(`Illegal session transition: ${from} -> ${to}`);
    this.name = 'InvalidSessionTransitionError';
  }
}

/**
 * Returns `to` when the move is legal, otherwise throws.
 *
 * Callers that legitimately race (e.g. a `match:ended` arriving while the user already
 * pressed Next) should use `canTransition` and drop the losing event rather than catching.
 */
export function transition(from: SessionState, to: SessionState): SessionState {
  if (!canTransition(from, to)) throw new InvalidSessionTransitionError(from, to);
  return to;
}

/** States in which the user is occupying a match slot on the server. */
export const IN_MATCH_STATES: readonly SessionState[] = [
  SessionState.MATCH_FOUND,
  SessionState.SIGNALING,
  SessionState.CONNECTING,
  SessionState.CONNECTED,
  SessionState.RECONNECTING,
];

export function isInMatch(state: SessionState): boolean {
  return IN_MATCH_STATES.includes(state);
}

/** States where a spinner/searching affordance is the correct UI. */
export function isBusy(state: SessionState): boolean {
  return (
    state === SessionState.REQUESTING_PERMISSIONS ||
    state === SessionState.QUEUED ||
    state === SessionState.MATCH_FOUND ||
    state === SessionState.SIGNALING ||
    state === SessionState.CONNECTING ||
    state === SessionState.RECONNECTING ||
    state === SessionState.SKIPPING
  );
}

/** True when the Next button should be enabled. */
export function canSkip(state: SessionState): boolean {
  return (
    state === SessionState.CONNECTED ||
    state === SessionState.CONNECTING ||
    state === SessionState.SIGNALING ||
    state === SessionState.RECONNECTING
  );
}

/** True when local media tracks should be live. */
export function needsLocalMedia(state: SessionState): boolean {
  return state !== SessionState.IDLE && state !== SessionState.ERROR;
}
