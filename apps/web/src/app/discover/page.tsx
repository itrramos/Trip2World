'use client';

import { countryName, formatDuration } from '@trip2world/shared';
import { type ConnectionQuality, REPORT_CATEGORIES, SessionState } from '@trip2world/types';
import {
  Camera,
  CameraOff,
  Flag,
  Loader2,
  LogOut,
  Mic,
  MicOff,
  PhoneOff,
  SkipForward,
  Signal,
  Sparkles,
  SwitchCamera,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { MEDIA_ERROR_COPY } from '@/lib/media';
import { useRequireAuth } from '@/components/session-provider';
import { useConversation } from '@/hooks/use-conversation';
import { Button, cn } from '@/components/ui';

const SEARCH_HINTS = [
  'Finding someone around the world…',
  'Looking for a good match…',
  'Widening the search…',
  'Almost there…',
];

export default function DiscoverPage() {
  const { status, user } = useRequireAuth();
  const conversation = useConversation();
  const {
    state,
    partner,
    quality,
    error,
    mediaError,
    cameraEnabled,
    microphoneEnabled,
    waitingSeconds,
  } = conversation;

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  /** Same remote stream, rendered blurred behind the letterboxed video. */
  const backdropVideoRef = useRef<HTMLVideoElement>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);

  /**
   * Attach streams imperatively.
   *
   * `srcObject` takes a MediaStream object, which cannot be expressed as a React prop —
   * passing it through `src` would stringify it. The effect re-runs on state changes
   * because the elements mount and unmount as the UI switches between states.
   */
  useEffect(() => {
    if (localVideoRef.current && conversation.localStream.current) {
      localVideoRef.current.srcObject = conversation.localStream.current;
    }
    if (remoteVideoRef.current && conversation.remoteStream.current) {
      remoteVideoRef.current.srcObject = conversation.remoteStream.current;
    }
    if (backdropVideoRef.current && conversation.remoteStream.current) {
      backdropVideoRef.current.srcObject = conversation.remoteStream.current;
    }
  }, [state, conversation.localStream, conversation.remoteStream]);

  // Call duration.
  useEffect(() => {
    if (state !== SessionState.CONNECTED) {
      setCallSeconds(0);
      return;
    }
    const interval = setInterval(() => setCallSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [state]);

  if (status === 'loading') {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand" aria-hidden />
        <span className="sr-only">Loading</span>
      </main>
    );
  }

  const inCall =
    state === SessionState.CONNECTED ||
    state === SessionState.CONNECTING ||
    state === SessionState.SIGNALING ||
    state === SessionState.RECONNECTING;

  const searching = state === SessionState.QUEUED || state === SessionState.MATCH_FOUND;
  const hintIndex = Math.min(Math.floor(waitingSeconds / 8), SEARCH_HINTS.length - 1);

  /**
   * The queue contains only us. Reported by the server, so it accounts for people
   * connected to other realtime nodes rather than just this one.
   */
  const alone = conversation.queueConfirmed && conversation.searchingNow === 1;

  return (
    <main className="relative flex min-h-dvh flex-col bg-black">
      {/* ── Remote video / stage ─────────────────────────────────────── */}
      <div className="relative flex-1 overflow-hidden">
        {inCall && (
          <>
            {/*
              Blurred backdrop.

              A phone films in portrait (9:16); a desktop frame is landscape. Filling that
              frame with `object-cover` crops away most of the picture — which is why the
              remote person appeared as a giant face. `object-contain` shows the whole
              frame instead, and this scaled, blurred copy of the same stream fills the
              leftover space so the result reads as intentional rather than as black bars.

              The same MediaStream can drive several <video> elements, so this costs no
              extra bandwidth and no second decode of a different stream.
            */}
            <video
              ref={backdropVideoRef}
              autoPlay
              playsInline
              muted
              aria-hidden
              className="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl brightness-50"
            />
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              // Never muted: this is the other person's audio, the entire point.
              className="absolute inset-0 h-full w-full object-contain"
            />
          </>
        )}

        {/* Idle / ready */}
        {(state === SessionState.IDLE ||
          state === SessionState.READY ||
          state === SessionState.REQUESTING_PERMISSIONS) &&
          !mediaError && (
            <StageMessage
              title={state === SessionState.REQUESTING_PERMISSIONS ? 'Allow your camera' : 'Ready when you are'}
              body={
                state === SessionState.REQUESTING_PERMISSIONS
                  ? 'Your browser will ask for permission. Nothing is shared until you start.'
                  : `Hi ${user?.displayName ?? user?.username ?? 'there'} — press Start to meet someone new.`
              }
            >
              {state === SessionState.REQUESTING_PERMISSIONS ? (
                <Loader2 className="h-6 w-6 animate-spin text-brand" aria-hidden />
              ) : (
                <Button
                  size="lg"
                  onClick={() => {
                    void (async () => {
                      // Media may already be live from a previous session on this page;
                      // re-requesting it would prompt again for no reason.
                      const ready =
                        conversation.localStream.current !== null ||
                        (await conversation.startMedia());
                      if (ready) conversation.joinQueue();
                    })();
                  }}
                >
                  Start Exploring
                </Button>
              )}
            </StageMessage>
          )}

        {/* Media permission failure */}
        {mediaError && (
          <StageMessage
            title={MEDIA_ERROR_COPY[mediaError.kind].title}
            body={MEDIA_ERROR_COPY[mediaError.kind].body}
            tone="danger"
          >
            {MEDIA_ERROR_COPY[mediaError.kind].retry && (
              <Button size="lg" onClick={() => void conversation.startMedia()}>
                Try again
              </Button>
            )}
          </StageMessage>
        )}

        {/* Searching */}
        {searching && (
          <StageMessage
            title={
              // Tell the truth about why nothing is happening. "Almost there…" while the
              // queue holds exactly one person is a lie the user can feel, and it makes a
              // genuinely empty room indistinguishable from a broken matchmaker.
              alone
                ? 'Nobody else is here right now'
                : !conversation.queueConfirmed
                  ? 'Connecting to Trip2World…'
                  : SEARCH_HINTS[hintIndex]!
            }
            body={
              alone
                ? 'You are the only person searching. Stay here and we will pair you the moment someone joins.'
                : !conversation.queueConfirmed
                  ? 'Waiting for the server to confirm your place in the queue.'
                  : `Searching for ${formatDuration(waitingSeconds)}${
                      conversation.searchingNow !== null
                        ? ` · ${conversation.searchingNow} searching`
                        : ''
                    }`
            }
          >
            <div className="relative flex h-24 w-24 items-center justify-center">
              <span className="absolute inset-0 rounded-full border border-brand/40 animate-pulse-ring" />
              <span
                className="absolute inset-0 rounded-full border border-brand/20 animate-pulse-ring"
                style={{ animationDelay: '0.8s' }}
              />
              <Sparkles className="h-8 w-8 text-brand" aria-hidden />
            </div>
            <Button variant="ghost" onClick={conversation.leaveQueue}>
              Cancel
            </Button>
          </StageMessage>
        )}

        {/* Partner left */}
        {state === SessionState.PARTNER_LEFT && (
          <StageMessage
            title="Your partner left the conversation"
            body="That happens — press Next to meet someone else."
          >
            <div className="flex gap-3">
              <Button size="lg" onClick={conversation.joinQueue}>
                Find someone new
              </Button>
              <Button variant="secondary" size="lg" onClick={conversation.endConversation}>
                Stop
              </Button>
            </div>
          </StageMessage>
        )}

        {/* Fatal error */}
        {state === SessionState.ERROR && error && (
          <StageMessage title={error.title} body={error.body} tone="danger">
            {error.retry ? (
              <Button size="lg" onClick={conversation.joinQueue}>
                Try again
              </Button>
            ) : (
              <Link href="/" className="text-sm text-muted underline underline-offset-4">
                Back to home
              </Link>
            )}
          </StageMessage>
        )}

        {/* Connecting overlay — sits on top of the (still black) remote video. */}
        {(state === SessionState.SIGNALING ||
          state === SessionState.CONNECTING ||
          state === SessionState.RECONNECTING) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
            <Loader2 className="h-7 w-7 animate-spin text-brand" aria-hidden />
            <p className="text-sm text-muted">
              {state === SessionState.RECONNECTING ? 'Reconnecting…' : 'Connecting…'}
            </p>
          </div>
        )}

        {/* Partner info */}
        {inCall && partner && (
          <div className="absolute left-4 top-4 flex items-center gap-3 rounded-full border border-white/10 bg-black/50 px-4 py-2 backdrop-blur">
            <span className="text-sm font-medium">{partner.displayName ?? partner.username}</span>
            {partner.country && (
              <span className="text-sm text-muted">{countryName(partner.country)}</span>
            )}
            <QualityBadge quality={quality} />
            {state === SessionState.CONNECTED && (
              <span className="tabular-nums text-xs text-muted">{formatDuration(callSeconds)}</span>
            )}
          </div>
        )}

        {/* Local preview */}
        {(inCall || searching || state === SessionState.READY) && (
          <div className="absolute bottom-28 right-4 h-40 w-28 overflow-hidden rounded border border-white/15 bg-surface shadow-2xl sm:h-48 sm:w-36">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              // Muted is essential — an unmuted self-view causes an audio feedback loop.
              muted
              className={cn('video-cover mirror', !cameraEnabled && 'opacity-0')}
            />
            {!cameraEnabled && (
              <div className="absolute inset-0 flex items-center justify-center">
                <CameraOff className="h-6 w-6 text-muted" aria-hidden />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Controls ─────────────────────────────────────────────────── */}
      <div className="relative z-10 border-t border-white/10 bg-black/80 px-4 py-4 backdrop-blur">
        {/*
          Zoom slider, shown only where the camera actually reports a zoom range —
          Chrome on Android for most cameras, essentially nowhere on desktop. Rendering a
          slider that silently does nothing is worse than not offering one.
        */}
        {conversation.zoom && (
          <div className="mx-auto mb-3 flex max-w-sm items-center gap-3 px-2">
            <ZoomOut className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            <input
              type="range"
              min={conversation.zoom.min}
              max={conversation.zoom.max}
              step={conversation.zoom.step}
              value={conversation.zoom.current}
              onChange={(event) => conversation.setZoom(Number(event.target.value))}
              aria-label="Camera zoom"
              className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-brand"
            />
            <ZoomIn className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          </div>
        )}

        <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 sm:gap-3">
          <ControlButton
            label={microphoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
            active={microphoneEnabled}
            onClick={conversation.toggleMicrophone}
            disabled={!conversation.localStream.current}
          >
            {microphoneEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </ControlButton>

          <ControlButton
            label={cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
            active={cameraEnabled}
            onClick={conversation.toggleCamera}
            disabled={!conversation.localStream.current}
          >
            {cameraEnabled ? <Camera className="h-5 w-5" /> : <CameraOff className="h-5 w-5" />}
          </ControlButton>

          {/* Only rendered when a second camera exists — a disabled button on a laptop
              with one webcam is noise. */}
          {conversation.canSwitchCamera && (
            <ControlButton
              label="Switch camera"
              onClick={() => void conversation.switchCamera()}
              disabled={!conversation.localStream.current || conversation.switchingCamera}
            >
              <SwitchCamera className="h-5 w-5" />
            </ControlButton>
          )}

          {/* Next is the primary action and is deliberately the largest, most reachable
              control — it is the one people press most, and often in a hurry. */}
          <Button
            size="lg"
            onClick={() => conversation.skip(true)}
            disabled={!inCall}
            className="min-w-[9rem]"
          >
            <SkipForward className="h-5 w-5" aria-hidden />
            Next
          </Button>

          <ControlButton
            label="Report this person"
            tone="danger"
            onClick={() => setReportOpen(true)}
            disabled={!inCall || !partner}
          >
            <Flag className="h-5 w-5" />
          </ControlButton>

          <ControlButton
            label={inCall ? 'End conversation' : 'Leave'}
            tone="danger"
            onClick={conversation.endConversation}
            disabled={!inCall && state !== SessionState.QUEUED}
          >
            {inCall ? <PhoneOff className="h-5 w-5" /> : <LogOut className="h-5 w-5" />}
          </ControlButton>
        </div>
      </div>

      {reportOpen && partner && (
        <ReportDialog
          partnerName={partner.displayName ?? partner.username}
          onClose={() => setReportOpen(false)}
          onSubmit={(category, details) => {
            conversation.reportPartner(category, details);
            setReportOpen(false);
          }}
        />
      )}
    </main>
  );
}

/* -------------------------------------------------------------------------- */

function StageMessage({
  title,
  body,
  tone = 'default',
  children,
}: {
  title: string;
  body: string;
  tone?: 'default' | 'danger';
  children?: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center">
      <h1 className={cn('text-2xl font-semibold tracking-tight', tone === 'danger' && 'text-danger')}>
        {title}
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-muted">{body}</p>
      {children}
    </div>
  );
}

const QUALITY_COPY: Record<ConnectionQuality, { label: string; className: string }> = {
  EXCELLENT: { label: 'Excellent', className: 'text-success' },
  GOOD: { label: 'Good', className: 'text-success' },
  FAIR: { label: 'Fair', className: 'text-warning' },
  POOR: { label: 'Poor', className: 'text-danger' },
  UNKNOWN: { label: 'Checking', className: 'text-muted' },
};

function QualityBadge({ quality }: { quality: ConnectionQuality }) {
  const { label, className } = QUALITY_COPY[quality];
  return (
    <span className={cn('flex items-center gap-1 text-xs', className)} title={`Connection: ${label}`}>
      <Signal className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">Connection quality: </span>
      {label}
    </span>
  );
}

function ControlButton({
  label,
  active,
  tone = 'default',
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // The icon carries no text, so the accessible name has to come from here.
      aria-label={label}
      title={label}
      aria-pressed={active !== undefined ? active : undefined}
      className={cn(
        'flex h-12 w-12 items-center justify-center rounded-full border transition-colors duration-fast',
        'disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger'
          ? 'border-danger/30 text-danger hover:bg-danger/10'
          : active === false
            ? 'border-danger/40 bg-danger/10 text-danger'
            : 'border-white/15 text-foreground hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}

const REPORT_LABELS: Record<string, string> = {
  NUDITY: 'Nudity or sexual content',
  HARASSMENT: 'Harassment',
  HATE: 'Hate or abusive behaviour',
  UNDERAGE: 'They appear to be under 18',
  VIOLENCE: 'Violence or threats',
  SPAM: 'Spam',
  SCAM: 'Scam',
  IMPERSONATION: 'Impersonation',
  OTHER: 'Something else',
};

function ReportDialog({
  partnerName,
  onClose,
  onSubmit,
}: {
  partnerName: string;
  onClose: () => void;
  onSubmit: (category: string, details?: string) => void;
}) {
  const [category, setCategory] = useState<string>('');
  const [details, setDetails] = useState('');

  // Escape must close a modal — it is the first thing keyboard users try.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
    >
      <div className="glass w-full max-w-md rounded-lg p-6">
        <h2 id="report-title" className="text-lg font-semibold">
          Report {partnerName}
        </h2>
        <p className="mt-1.5 text-sm text-muted">
          The conversation will end and you will not be matched with them again.
        </p>

        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Reason for reporting</legend>
          {REPORT_CATEGORIES.map((value) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-sm border px-4 py-2.5 text-sm transition-colors',
                category === value ? 'border-brand bg-brand/10' : 'border-border hover:bg-surface-raised',
              )}
            >
              <input
                type="radio"
                name="category"
                value={value}
                checked={category === value}
                onChange={() => setCategory(value)}
                className="accent-brand"
              />
              {REPORT_LABELS[value] ?? value}
            </label>
          ))}
        </fieldset>

        <textarea
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Anything else our moderators should know? (optional)"
          className="mt-4 w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm placeholder:text-muted/60 focus:border-brand"
        />

        <div className="mt-5 flex gap-3">
          <Button variant="secondary" fullWidth onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            fullWidth
            disabled={!category}
            onClick={() => onSubmit(category, details.trim() || undefined)}
          >
            Send report
          </Button>
        </div>
      </div>
    </div>
  );
}
