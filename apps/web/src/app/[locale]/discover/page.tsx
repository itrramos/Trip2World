'use client';

import { countryName, formatDuration } from '@trip2world/shared';
import { type ConnectionQuality, REPORT_CATEGORIES, SessionState } from '@trip2world/types';
import {
  Ban,
  Camera,
  CameraOff,
  Coins,
  Flag,
  Gift,
  Settings,
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
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { MEDIA_ERROR_RETRYABLE } from '@/lib/media';
import { useRequireAuth } from '@/components/session-provider';
import { TipDialog, TipOfferPrompt, TipToast } from '@/components/tips';
import { useConversation } from '@/hooks/use-conversation';
import { Button, cn } from '@/components/ui';
import { Link } from '@/i18n/navigation';

/** Four escalating hints, chosen by how long the search has been running. */
const SEARCH_HINT_COUNT = 4;

export default function DiscoverPage() {
  const t = useTranslations('discover');
  const tMedia = useTranslations('media');
  const tCommon = useTranslations('common');
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
  const [blockOpen, setBlockOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);

  /** Most recent tip, shown briefly as a toast then cleared. */
  const [latestTip, setLatestTip] = useState<(typeof conversation.tips)[number] | null>(null);

  useEffect(() => {
    const newest = conversation.tips.at(-1);
    if (!newest) return;
    setLatestTip(newest);
    const timer = setTimeout(() => setLatestTip(null), 4000);
    return () => clearTimeout(timer);
  }, [conversation.tips]);

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
        <span className="sr-only">{tCommon('loading')}</span>
      </main>
    );
  }

  const inCall =
    state === SessionState.CONNECTED ||
    state === SessionState.CONNECTING ||
    state === SessionState.SIGNALING ||
    state === SessionState.RECONNECTING;

  const searching = state === SessionState.QUEUED || state === SessionState.MATCH_FOUND;
  const hintIndex = Math.min(Math.floor(waitingSeconds / 8), SEARCH_HINT_COUNT - 1);

  /**
   * The queue contains only us. Reported by the server, so it accounts for people
   * connected to other realtime nodes rather than just this one.
   */
  const alone = conversation.queueConfirmed && conversation.searchingNow === 1;

  return (
    <main className="relative flex min-h-dvh flex-col bg-black">
      {/*
        Top bar. Previously there was no route out of this page at all — Settings, the
        blocked list and the token balance were all unreachable once you were here.
        Kept minimal so it does not compete with the video.
      */}
      <div className="absolute right-4 top-4 z-30 flex items-center gap-2">
        <Link
          href="/settings/tokens"
          className="flex items-center gap-1.5 rounded-full border border-white/15 bg-black/50 px-3 py-1.5 text-xs backdrop-blur transition-colors hover:bg-white/10"
        >
          <Coins className="h-3.5 w-3.5 text-brand" aria-hidden />
          <span className="tabular-nums">
            {conversation.tokenBalance === null ? '—' : conversation.tokenBalance.toLocaleString()}
          </span>
          <span className="sr-only">{t('tokensLabel')}</span>
        </Link>

        <Link
          href="/settings"
          aria-label={t('settings')}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/50 backdrop-blur transition-colors hover:bg-white/10"
        >
          <Settings className="h-4 w-4" aria-hidden />
        </Link>
      </div>

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
              title={
                state === SessionState.REQUESTING_PERMISSIONS
                  ? t('permissionsTitle')
                  : t('readyTitle')
              }
              body={
                state === SessionState.REQUESTING_PERMISSIONS
                  ? t('permissionsBody')
                  : t('readyBody', {
                      name: user?.displayName ?? user?.username ?? t('readyFallbackName'),
                    })
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
                  {t('start')}
                </Button>
              )}
            </StageMessage>
          )}

        {/* Media permission failure */}
        {mediaError && (
          <StageMessage
            title={tMedia(`${mediaError.kind}.title`)}
            body={tMedia(`${mediaError.kind}.body`)}
            tone="danger"
          >
            {MEDIA_ERROR_RETRYABLE[mediaError.kind] && (
              <Button size="lg" onClick={() => void conversation.startMedia()}>
                {t('tryAgain')}
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
                ? t('aloneTitle')
                : !conversation.queueConfirmed
                  ? t('connectingToServer')
                  : t(`searchHints.${hintIndex}`)
            }
            body={
              alone
                ? t('aloneBody')
                : !conversation.queueConfirmed
                  ? t('connectingToServerBody')
                  : t('searchingFor', { duration: formatDuration(waitingSeconds) }) +
                    (conversation.searchingNow !== null
                      ? ` · ${t('searchingCount', { count: conversation.searchingNow })}`
                      : '')
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
              {tCommon('cancel')}
            </Button>
          </StageMessage>
        )}

        {/* Partner left */}
        {state === SessionState.PARTNER_LEFT && (
          <StageMessage title={t('partnerLeftTitle')} body={t('partnerLeftBody')}>
            <div className="flex gap-3">
              <Button size="lg" onClick={conversation.joinQueue}>
                {t('findSomeoneNew')}
              </Button>
              <Button variant="secondary" size="lg" onClick={conversation.endConversation}>
                {t('stop')}
              </Button>
            </div>
          </StageMessage>
        )}

        {/* Fatal error */}
        {state === SessionState.ERROR && error && (
          <StageMessage
            title={t(`errors.${error.key}.title`)}
            // A server-supplied reason is always more specific than the generic body —
            // "posting sexual content" beats "your account is restricted".
            body={error.detail ?? t(`errors.${error.key}.body`)}
            tone="danger"
          >
            {error.retry ? (
              <Button size="lg" onClick={conversation.joinQueue}>
                {t('tryAgain')}
              </Button>
            ) : (
              <Link href="/" className="text-sm text-muted underline underline-offset-4">
                {t('backToHome')}
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
              {state === SessionState.RECONNECTING ? t('reconnecting') : t('connecting')}
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

        {/*
          The recipient's consent gate for a time offer. Rendered over the video, but it
          never blocks the control bar underneath — Next, report and block stay reachable
          while it is on screen, which is the whole point of the design.
        */}
        {conversation.pendingOffer && (
          <TipOfferPrompt
            offer={conversation.pendingOffer}
            onRespond={conversation.respondToOffer}
          />
        )}

        {latestTip && <TipToast key={latestTip.tipId} tip={latestTip} />}

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
              aria-label={t('controls.zoom')}
              className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-brand"
            />
            <ZoomIn className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          </div>
        )}

        {/* Wraps rather than overflowing: eight controls do not fit one row on a narrow
            phone, and a horizontally-scrolling control bar hides the button you need. */}
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-2 sm:gap-3">
          <ControlButton
            label={
              microphoneEnabled ? t('controls.muteMicrophone') : t('controls.unmuteMicrophone')
            }
            active={microphoneEnabled}
            onClick={conversation.toggleMicrophone}
            disabled={!conversation.localStream.current}
          >
            {microphoneEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </ControlButton>

          <ControlButton
            label={cameraEnabled ? t('controls.cameraOff') : t('controls.cameraOn')}
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
              label={t('controls.switchCamera')}
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
            {t('controls.next')}
          </Button>

          <ControlButton
            label={t('controls.tip')}
            onClick={() => setTipOpen(true)}
            disabled={!inCall || !partner}
          >
            <Gift className="h-5 w-5" />
          </ControlButton>

          <ControlButton
            label={t('controls.block')}
            tone="danger"
            onClick={() => setBlockOpen(true)}
            disabled={!inCall || !partner}
          >
            <Ban className="h-5 w-5" />
          </ControlButton>

          <ControlButton
            label={t('controls.report')}
            tone="danger"
            onClick={() => setReportOpen(true)}
            disabled={!inCall || !partner}
          >
            <Flag className="h-5 w-5" />
          </ControlButton>

          <ControlButton
            label={inCall ? t('controls.endCall') : t('controls.leave')}
            tone="danger"
            onClick={conversation.endConversation}
            disabled={!inCall && state !== SessionState.QUEUED}
          >
            {inCall ? <PhoneOff className="h-5 w-5" /> : <LogOut className="h-5 w-5" />}
          </ControlButton>
        </div>
      </div>

      {/*
        Block is permanent and mutual, so it gets a confirmation. Report does not — a
        report is reviewable and reversible by a moderator, and putting friction in front
        of reporting someone frightening is the wrong trade.
      */}
      {blockOpen && partner && (
        <ConfirmDialog
          title={t('blockDialog.title', { name: partner.displayName ?? partner.username })}
          body={t('blockDialog.body')}
          confirmLabel={t('blockDialog.confirm')}
          cancelLabel={tCommon('cancel')}
          onCancel={() => setBlockOpen(false)}
          onConfirm={() => {
            conversation.blockPartner();
            setBlockOpen(false);
          }}
        />
      )}

      {tipOpen && partner && (
        <TipDialog
          partnerName={partner.displayName ?? partner.username}
          balance={conversation.tokenBalance}
          onClose={() => setTipOpen(false)}
          onSend={(tokens, options) => conversation.sendTip(tokens, options)}
        />
      )}

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

/** Confirmation for an action that cannot be undone from here. */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
    >
      <div className="glass w-full max-w-sm rounded-lg p-6">
        <h2 id="confirm-title" className="text-lg font-semibold">
          {title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
        <div className="mt-6 flex gap-3">
          <Button variant="secondary" fullWidth onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant="danger" fullWidth onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Colour only. The words come from the catalogue. */
const QUALITY_CLASS: Record<ConnectionQuality, string> = {
  EXCELLENT: 'text-success',
  GOOD: 'text-success',
  FAIR: 'text-warning',
  POOR: 'text-danger',
  UNKNOWN: 'text-muted',
};

function QualityBadge({ quality }: { quality: ConnectionQuality }) {
  const t = useTranslations('discover.quality');
  const label = t(quality);

  return (
    <span
      className={cn('flex items-center gap-1 text-xs', QUALITY_CLASS[quality])}
      title={t('label', { quality: label })}
    >
      <Signal className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{t('srLabel')} </span>
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

function ReportDialog({
  partnerName,
  onClose,
  onSubmit,
}: {
  partnerName: string;
  onClose: () => void;
  onSubmit: (category: string, details?: string) => void;
}) {
  const t = useTranslations('discover.reportDialog');
  const tCommon = useTranslations('common');
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
          {t('title', { name: partnerName })}
        </h2>
        <p className="mt-1.5 text-sm text-muted">{t('subtitle')}</p>

        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">{t('legend')}</legend>
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
              {t(`categories.${value}`)}
            </label>
          ))}
        </fieldset>

        <textarea
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          rows={3}
          maxLength={1000}
          placeholder={t('detailsPlaceholder')}
          className="mt-4 w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm placeholder:text-muted/60 focus:border-brand"
        />

        <div className="mt-5 flex gap-3">
          <Button variant="secondary" fullWidth onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="danger"
            fullWidth
            disabled={!category}
            onClick={() => onSubmit(category, details.trim() || undefined)}
          >
            {t('submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
