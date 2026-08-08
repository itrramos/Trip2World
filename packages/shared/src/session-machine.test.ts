import { SessionState } from '@trip2world/types';
import { describe, expect, it } from 'vitest';
import {
  canSkip,
  canTransition,
  InvalidSessionTransitionError,
  isBusy,
  isInMatch,
  transition,
} from './session-machine.js';

describe('session state machine', () => {
  it('walks the happy path from idle to connected', () => {
    const path = [
      SessionState.IDLE,
      SessionState.REQUESTING_PERMISSIONS,
      SessionState.READY,
      SessionState.QUEUED,
      SessionState.MATCH_FOUND,
      SessionState.SIGNALING,
      SessionState.CONNECTING,
      SessionState.CONNECTED,
    ];

    let state: SessionState = path[0]!;
    for (const next of path.slice(1)) {
      state = transition(state, next);
    }
    expect(state).toBe(SessionState.CONNECTED);
  });

  it('supports the skip -> requeue -> rematch loop', () => {
    let state: SessionState = SessionState.CONNECTED;
    state = transition(state, SessionState.SKIPPING);
    state = transition(state, SessionState.QUEUED);
    state = transition(state, SessionState.MATCH_FOUND);
    expect(state).toBe(SessionState.MATCH_FOUND);
  });

  it('supports partner-left -> requeue', () => {
    let state: SessionState = SessionState.CONNECTED;
    state = transition(state, SessionState.PARTNER_LEFT);
    state = transition(state, SessionState.QUEUED);
    expect(state).toBe(SessionState.QUEUED);
  });

  it('allows a bounded reconnect that recovers the same call', () => {
    let state: SessionState = SessionState.CONNECTED;
    state = transition(state, SessionState.RECONNECTING);
    state = transition(state, SessionState.CONNECTED);
    expect(state).toBe(SessionState.CONNECTED);
  });

  it('allows a reconnect that gives up and returns to the queue', () => {
    const state = transition(
      transition(SessionState.CONNECTED, SessionState.RECONNECTING),
      SessionState.QUEUED,
    );
    expect(state).toBe(SessionState.QUEUED);
  });

  it('rejects impossible jumps', () => {
    expect(() => transition(SessionState.IDLE, SessionState.CONNECTED)).toThrow(
      InvalidSessionTransitionError,
    );
    expect(() => transition(SessionState.QUEUED, SessionState.CONNECTED)).toThrow();
    expect(() => transition(SessionState.READY, SessionState.MATCH_FOUND)).toThrow();
    // Cannot go straight from searching back into a call without a new match.
    expect(() => transition(SessionState.SKIPPING, SessionState.CONNECTED)).toThrow();
  });

  it('permits ERROR and IDLE escapes from every state', () => {
    for (const state of Object.values(SessionState)) {
      expect(canTransition(state, SessionState.ERROR)).toBe(true);
      expect(canTransition(state, SessionState.IDLE)).toBe(true);
    }
  });

  it('treats a self-transition as a no-op rather than an error', () => {
    expect(transition(SessionState.CONNECTED, SessionState.CONNECTED)).toBe(SessionState.CONNECTED);
  });

  it('classifies match occupancy correctly', () => {
    expect(isInMatch(SessionState.CONNECTED)).toBe(true);
    expect(isInMatch(SessionState.SIGNALING)).toBe(true);
    expect(isInMatch(SessionState.RECONNECTING)).toBe(true);
    expect(isInMatch(SessionState.QUEUED)).toBe(false);
    // SKIPPING means the server slot has already been released.
    expect(isInMatch(SessionState.SKIPPING)).toBe(false);
  });

  it('only enables Next while a peer connection exists or is forming', () => {
    expect(canSkip(SessionState.CONNECTED)).toBe(true);
    expect(canSkip(SessionState.CONNECTING)).toBe(true);
    expect(canSkip(SessionState.QUEUED)).toBe(false);
    expect(canSkip(SessionState.IDLE)).toBe(false);
  });

  it('shows a busy affordance only while work is pending', () => {
    expect(isBusy(SessionState.QUEUED)).toBe(true);
    expect(isBusy(SessionState.CONNECTING)).toBe(true);
    expect(isBusy(SessionState.CONNECTED)).toBe(false);
    expect(isBusy(SessionState.IDLE)).toBe(false);
  });
});
