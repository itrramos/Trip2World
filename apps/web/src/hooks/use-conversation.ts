'use client';

import {
  canTransition,
  deriveConnectionQuality,
  NEGOTIATION_TIMEOUT_MS,
  RECONNECT_TIMEOUT_MS,
} from '@trip2world/shared';
import {
  type ChatMessage,
  type ClientToServerEvents,
  type ConnectionQuality,
  type MatchFoundPayload,
  type PublicProfile,
  REALTIME_NAMESPACE,
  type RealtimeError,
  type ServerToClientEvents,
  SessionState,
} from '@trip2world/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { ensureAccessToken } from '@/lib/api';
import { MediaError, requestUserMedia, stopStream } from '@/lib/media';

type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? '';
const REALTIME_PATH = process.env.NEXT_PUBLIC_REALTIME_PATH ?? '/rt';

export interface ConversationState {
  state: SessionState;
  partner: PublicProfile | null;
  matchId: string | null;
  sharedInterests: string[];
  messages: ChatMessage[];
  quality: ConnectionQuality;
  error: { title: string; body: string; retry: boolean } | null;
  mediaError: MediaError | null;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  /** Seconds spent in the queue, for the searching UI. */
  waitingSeconds: number;
}

/**
 * Owns the entire conversation lifecycle: media, socket, peer connection, and the
 * session state machine.
 *
 * Keeping these together is deliberate. They are not independent — an ICE candidate is
 * meaningless without the match it belongs to, and a state transition is invalid without
 * knowing whether the peer connection survived. Splitting them into separate hooks means
 * three pieces of state that can disagree, and the disagreements show up as a UI that
 * says "connecting" over a dead call.
 *
 * Every transition goes through `canTransition`, so a late event from a match the user
 * already skipped is dropped rather than corrupting the current one.
 */
export function useConversation() {
  const [state, setState] = useState<SessionState>(SessionState.IDLE);
  const [partner, setPartner] = useState<PublicProfile | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [sharedInterests, setSharedInterests] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quality, setQuality] = useState<ConnectionQuality>('UNKNOWN');
  const [error, setError] = useState<ConversationState['error']>(null);
  const [mediaError, setMediaError] = useState<MediaError | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [waitingSeconds, setWaitingSeconds] = useState(0);

  const socketRef = useRef<RealtimeSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);

  /**
   * The match id as seen by callbacks.
   *
   * Socket handlers close over their creation-time scope, so they cannot read the latest
   * `matchId` state. A ref is the value they can trust — and getting this wrong means
   * relaying ICE candidates into a conversation that already ended.
   */
  const matchIdRef = useRef<string | null>(null);
  const stateRef = useRef<SessionState>(SessionState.IDLE);

  /** ICE candidates that arrived before the remote description was set. */
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const negotiationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueStartedAtRef = useRef<number>(0);

  /** Guarded state transition. Returns false when the move was illegal and skipped. */
  const transitionTo = useCallback((next: SessionState): boolean => {
    if (!canTransition(stateRef.current, next)) return false;
    stateRef.current = next;
    setState(next);
    return true;
  }, []);

  /* ------------------------------------------------------------------ */
  /* Teardown                                                            */
  /* ------------------------------------------------------------------ */

  const clearTimers = useCallback(() => {
    if (negotiationTimerRef.current) clearTimeout(negotiationTimerRef.current);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    negotiationTimerRef.current = null;
    reconnectTimerRef.current = null;
  }, []);

  /**
   * Close the peer connection and release the remote stream.
   *
   * Handlers are detached before `close()` because closing fires connection-state events,
   * and acting on those during teardown re-enters this function.
   */
  const closePeer = useCallback(() => {
    clearTimers();

    const peer = peerRef.current;
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.onnegotiationneeded = null;
      try {
        peer.close();
      } catch {
        // Already closed.
      }
    }
    peerRef.current = null;

    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;

    pendingCandidatesRef.current = [];
    matchIdRef.current = null;
    setMatchId(null);
    setPartner(null);
    setSharedInterests([]);
    setMessages([]);
    setQuality('UNKNOWN');
  }, [clearTimers]);

  /* ------------------------------------------------------------------ */
  /* Peer connection                                                     */
  /* ------------------------------------------------------------------ */

  const createPeer = useCallback(
    (iceServers: RTCIceServer[], activeMatchId: string): RTCPeerConnection => {
      const peer = new RTCPeerConnection({
        iceServers,
        // Gather from all candidate types. Forcing `relay` would work everywhere but
        // route every call through TURN, which is the expensive path.
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });

      // Publish local tracks.
      const localStream = localStreamRef.current;
      if (localStream) {
        for (const track of localStream.getTracks()) {
          peer.addTrack(track, localStream);
        }
      }

      const remoteStream = new MediaStream();
      remoteStreamRef.current = remoteStream;

      peer.ontrack = (event) => {
        for (const track of event.streams[0]?.getTracks() ?? [track_of(event)]) {
          if (track) remoteStream.addTrack(track);
        }
      };

      peer.onicecandidate = (event) => {
        if (!event.candidate) return;
        socketRef.current?.emit('webrtc:ice', {
          matchId: activeMatchId,
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          },
        });
      };

      peer.onconnectionstatechange = () => {
        switch (peer.connectionState) {
          case 'connected':
            clearTimers();
            transitionTo(SessionState.CONNECTED);
            socketRef.current?.emit('match:connected', { matchId: activeMatchId });
            break;

          case 'disconnected':
            /**
             * `disconnected` is often transient — a brief network change recovers on its
             * own. Give it a bounded window before tearing the call down, rather than
             * ending a conversation because someone walked between two Wi-Fi APs.
             */
            if (transitionTo(SessionState.RECONNECTING)) {
              reconnectTimerRef.current = setTimeout(() => {
                if (peerRef.current?.connectionState !== 'connected') {
                  endMatchLocally('DISCONNECTED');
                }
              }, RECONNECT_TIMEOUT_MS);
            }
            break;

          case 'failed':
            // `failed` is terminal — ICE has exhausted every candidate pair.
            endMatchLocally('ERROR');
            break;

          default:
            break;
        }
      };

      return peer;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearTimers, transitionTo],
  );

  /** Narrow helper so `ontrack` compiles without a non-null assertion. */
  function track_of(event: RTCTrackEvent): MediaStreamTrack | null {
    return event.track ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Match lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  const endMatchLocally = useCallback(
    (_reason: string) => {
      closePeer();
      transitionTo(SessionState.PARTNER_LEFT);
    },
    [closePeer, transitionTo],
  );

  const handleMatchFound = useCallback(
    async (payload: MatchFoundPayload) => {
      if (!transitionTo(SessionState.MATCH_FOUND)) return;

      matchIdRef.current = payload.matchId;
      setMatchId(payload.matchId);
      setPartner(payload.partner);
      setSharedInterests(payload.sharedInterests);
      setMessages([]);

      const peer = createPeer(payload.iceServers as RTCIceServer[], payload.matchId);
      peerRef.current = peer;

      transitionTo(SessionState.SIGNALING);

      /**
       * Negotiation deadline. If signaling never completes — a wedged client, a NAT that
       * drops everything — abandon the match rather than leaving both users staring at a
       * spinner. The server enforces the same deadline independently.
       */
      negotiationTimerRef.current = setTimeout(() => {
        if (stateRef.current !== SessionState.CONNECTED) {
          skip(true);
        }
      }, payload.negotiationTimeoutMs || NEGOTIATION_TIMEOUT_MS);

      // Exactly one side offers; the server decided which, so there is no glare.
      if (payload.isInitiator) {
        try {
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          socketRef.current?.emit('webrtc:offer', {
            matchId: payload.matchId,
            sdp: offer.sdp ?? '',
            type: 'offer',
          });
          transitionTo(SessionState.CONNECTING);
        } catch {
          skip(true);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [createPeer, transitionTo],
  );

  /** Apply candidates that arrived before the remote description existed. */
  const flushPendingCandidates = useCallback(async (peer: RTCPeerConnection) => {
    const pending = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of pending) {
      try {
        await peer.addIceCandidate(candidate);
      } catch {
        // A candidate that no longer applies is not fatal.
      }
    }
  }, []);

  /* ------------------------------------------------------------------ */
  /* Public actions                                                      */
  /* ------------------------------------------------------------------ */

  const startMedia = useCallback(async (): Promise<boolean> => {
    setMediaError(null);
    transitionTo(SessionState.REQUESTING_PERMISSIONS);

    try {
      const stream = await requestUserMedia();
      localStreamRef.current = stream;
      setCameraEnabled(stream.getVideoTracks().some((t) => t.enabled));
      setMicrophoneEnabled(stream.getAudioTracks().some((t) => t.enabled));
      transitionTo(SessionState.READY);
      return true;
    } catch (caught) {
      const mediaFailure =
        caught instanceof MediaError ? caught : new MediaError('UNKNOWN', 'Could not start camera.');
      setMediaError(mediaFailure);
      transitionTo(SessionState.ERROR);
      return false;
    }
  }, [transitionTo]);

  const joinQueue = useCallback(() => {
    const socket = socketRef.current;
    const stream = localStreamRef.current;
    if (!socket || !stream) return;

    queueStartedAtRef.current = Date.now();
    setWaitingSeconds(0);
    setError(null);

    if (!transitionTo(SessionState.QUEUED)) return;

    socket.emit('queue:join', {
      hasCamera: stream.getVideoTracks().length > 0,
      hasMicrophone: stream.getAudioTracks().length > 0,
    });
  }, [transitionTo]);

  const leaveQueue = useCallback(() => {
    socketRef.current?.emit('queue:leave');
    transitionTo(SessionState.READY);
  }, [transitionTo]);

  /** Press Next: end the current call and immediately search again. */
  const skip = useCallback(
    (requeue = true) => {
      const currentMatch = matchIdRef.current;
      if (!currentMatch) return;

      transitionTo(SessionState.SKIPPING);
      socketRef.current?.emit('match:skip', { matchId: currentMatch, requeue });
      closePeer();

      if (requeue) {
        queueStartedAtRef.current = Date.now();
        setWaitingSeconds(0);
        transitionTo(SessionState.QUEUED);
      } else {
        transitionTo(SessionState.READY);
      }
    },
    [closePeer, transitionTo],
  );

  const endConversation = useCallback(() => {
    const currentMatch = matchIdRef.current;
    if (currentMatch) socketRef.current?.emit('match:end', { matchId: currentMatch });
    closePeer();
    transitionTo(SessionState.READY);
  }, [closePeer, transitionTo]);

  const toggleCamera = useCallback(() => {
    const tracks = localStreamRef.current?.getVideoTracks() ?? [];
    const next = !tracks.some((track) => track.enabled);
    // Disabling the track keeps the connection intact and sends black frames, which is
    // far cheaper than renegotiating the whole peer connection.
    tracks.forEach((track) => (track.enabled = next));
    setCameraEnabled(next);
  }, []);

  const toggleMicrophone = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    const next = !tracks.some((track) => track.enabled);
    tracks.forEach((track) => (track.enabled = next));
    setMicrophoneEnabled(next);
  }, []);

  const sendMessage = useCallback((body: string) => {
    const currentMatch = matchIdRef.current;
    if (!currentMatch || !body.trim()) return;
    socketRef.current?.emit('chat:message', {
      matchId: currentMatch,
      body,
      clientId: crypto.randomUUID(),
    });
  }, []);

  const reportPartner = useCallback((category: string, details?: string) => {
    const partnerId = partner?.id;
    if (!partnerId) return;
    socketRef.current?.emit('user:report', {
      matchId: matchIdRef.current,
      reportedUserId: partnerId,
      category: category as never,
      details,
      alsoBlock: true,
    });
    closePeer();
    transitionTo(SessionState.READY);
  }, [partner, closePeer, transitionTo]);

  const blockPartner = useCallback(() => {
    const partnerId = partner?.id;
    if (!partnerId) return;
    socketRef.current?.emit('user:block', { userId: partnerId, matchId: matchIdRef.current });
    closePeer();
    transitionTo(SessionState.READY);
  }, [partner, closePeer, transitionTo]);

  /* ------------------------------------------------------------------ */
  /* Socket wiring                                                       */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    let disposed = false;
    let socket: RealtimeSocket | null = null;

    void (async () => {
      const token = await ensureAccessToken();
      if (!token || disposed) return;

      socket = io(`${REALTIME_URL}${REALTIME_NAMESPACE}`, {
        path: REALTIME_PATH,
        // Token in the handshake payload, never a query string: query strings are logged
        // by proxies and land in browser history.
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 5_000,
        withCredentials: true,
      }) as RealtimeSocket;

      socketRef.current = socket;

      socket.on('connect_error', () => {
        setError({
          title: 'Cannot reach Trip2World',
          body: 'We lost the connection to our servers. Retrying…',
          retry: false,
        });
      });

      socket.on('connect', () => setError(null));

      socket.on('match:found', (payload) => void handleMatchFound(payload));

      socket.on('webrtc:offer', (payload) => {
        void (async () => {
          const peer = peerRef.current;
          if (!peer || payload.matchId !== matchIdRef.current) return;

          try {
            await peer.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
            await flushPendingCandidates(peer);

            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            socket?.emit('webrtc:answer', {
              matchId: payload.matchId,
              sdp: answer.sdp ?? '',
              type: 'answer',
            });
            transitionTo(SessionState.CONNECTING);
          } catch {
            skip(true);
          }
        })();
      });

      socket.on('webrtc:answer', (payload) => {
        void (async () => {
          const peer = peerRef.current;
          if (!peer || payload.matchId !== matchIdRef.current) return;
          try {
            await peer.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
            await flushPendingCandidates(peer);
          } catch {
            skip(true);
          }
        })();
      });

      socket.on('webrtc:ice', (payload) => {
        void (async () => {
          const peer = peerRef.current;
          if (!peer || payload.matchId !== matchIdRef.current) return;

          // An empty candidate string is the end-of-candidates signal.
          if (!payload.candidate.candidate) return;

          // Candidates can arrive before the remote description; buffer them or
          // addIceCandidate throws and the connection silently never completes.
          if (!peer.remoteDescription) {
            pendingCandidatesRef.current.push(payload.candidate);
            return;
          }

          try {
            await peer.addIceCandidate(payload.candidate);
          } catch {
            // Non-fatal.
          }
        })();
      });

      socket.on('match:partner-left', () => {
        closePeer();
        transitionTo(SessionState.PARTNER_LEFT);
      });

      socket.on('match:ended', (payload) => {
        closePeer();
        if (payload.requeued) {
          queueStartedAtRef.current = Date.now();
          setWaitingSeconds(0);
          transitionTo(SessionState.QUEUED);
        } else {
          transitionTo(SessionState.READY);
        }
      });

      socket.on('chat:message', (message) => {
        setMessages((previous) => [...previous, message]);
      });

      socket.on('account:restricted', (payload) => {
        closePeer();
        setError({
          title: payload.status === 'BANNED' ? 'Your account is restricted' : 'Your account is suspended',
          body: payload.reason,
          retry: false,
        });
        transitionTo(SessionState.ERROR);
      });

      socket.on('error', (payload: RealtimeError) => {
        // Rate limiting and cooldowns are expected friction, not failures — surfacing
        // them as a full error state would be alarming and wrong.
        if (payload.code === 'RATE_LIMITED' || payload.code === 'SKIP_COOLDOWN') return;

        setError({ title: 'Something went wrong', body: payload.message, retry: true });
      });
    })();

    return () => {
      disposed = true;
      socket?.removeAllListeners();
      socket?.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- Presence heartbeat -------------------------------------------- */

  useEffect(() => {
    const interval = setInterval(() => socketRef.current?.emit('presence:heartbeat'), 30_000);
    return () => clearInterval(interval);
  }, []);

  /* --- Queue timer ---------------------------------------------------- */

  useEffect(() => {
    if (state !== SessionState.QUEUED) return;
    const interval = setInterval(() => {
      setWaitingSeconds(Math.floor((Date.now() - queueStartedAtRef.current) / 1000));
    }, 1_000);
    return () => clearInterval(interval);
  }, [state]);

  /* --- Connection quality sampling ------------------------------------ */

  useEffect(() => {
    if (state !== SessionState.CONNECTED) return;

    const interval = setInterval(() => {
      void (async () => {
        const peer = peerRef.current;
        if (!peer) return;

        const stats = await peer.getStats();
        let rtt: number | null = null;
        let lossPct: number | null = null;
        let candidateType: string | null = null;

        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (typeof report.currentRoundTripTime === 'number') {
              rtt = report.currentRoundTripTime * 1000;
            }
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            const lost = report.packetsLost ?? 0;
            const received = report.packetsReceived ?? 0;
            if (received > 0) lossPct = (lost / (lost + received)) * 100;
          }
          if (report.type === 'local-candidate' && report.candidateType) {
            candidateType = report.candidateType;
          }
        });

        const derived = deriveConnectionQuality(rtt, lossPct);
        setQuality(derived);

        socketRef.current?.emit('stats:report', {
          matchId: matchIdRef.current ?? '',
          stats: {
            quality: derived,
            roundTripTimeMs: rtt,
            packetsLostPct: lossPct,
            candidateType: candidateType as never,
          },
        });
      })();
    }, 5_000);

    return () => clearInterval(interval);
  }, [state]);

  /* --- Unmount cleanup ------------------------------------------------ */

  useEffect(() => {
    return () => {
      closePeer();
      // Release the camera, or its light stays on after leaving the page.
      stopStream(localStreamRef.current);
      localStreamRef.current = null;
    };
  }, [closePeer]);

  return {
    state,
    partner,
    matchId,
    sharedInterests,
    messages,
    quality,
    error,
    mediaError,
    cameraEnabled,
    microphoneEnabled,
    waitingSeconds,

    localStream: localStreamRef,
    remoteStream: remoteStreamRef,

    startMedia,
    joinQueue,
    leaveQueue,
    skip,
    endConversation,
    toggleCamera,
    toggleMicrophone,
    sendMessage,
    reportPartner,
    blockPartner,
  };
}
