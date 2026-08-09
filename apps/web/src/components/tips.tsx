'use client';

import type { TipReceivedPayload } from '@trip2world/types';
import { Button, cn } from '@trip2world/ui';
import { Coins, Gift, Clock } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

/** Quick amounts. Small enough to be casual, large enough to mean something. */
const QUICK_AMOUNTS = [10, 50, 100, 250];

/** Time offers a tip can carry. */
const TIME_OFFERS = [
  { seconds: 0, label: 'No time offer' },
  { seconds: 120, label: '+2 minutes' },
  { seconds: 300, label: '+5 minutes' },
  { seconds: 600, label: '+10 minutes' },
];

/**
 * Send a tip.
 *
 * The copy is deliberate about two things: tips are non-refundable, and a time offer is
 * an *offer*. Presenting it as buying someone's time would be both untrue and the wrong
 * expectation to set — the recipient can decline and keep the tokens.
 */
export function TipDialog({
  partnerName,
  balance,
  onClose,
  onSend,
}: {
  partnerName: string;
  balance: number | null;
  onClose: () => void;
  onSend: (tokens: number, options: { message?: string; offeredSeconds?: number }) => void;
}) {
  const [amount, setAmount] = useState(QUICK_AMOUNTS[1]!);
  const [offeredSeconds, setOfferedSeconds] = useState(0);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const insufficient = balance !== null && amount > balance;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tip-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
    >
      <div className="glass w-full max-w-md rounded-lg p-6">
        <h2 id="tip-title" className="flex items-center gap-2 text-lg font-semibold">
          <Gift className="h-5 w-5 text-brand" aria-hidden />
          Send {partnerName} a tip
        </h2>

        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted">
          <Coins className="h-4 w-4" aria-hidden />
          {balance === null ? 'Loading balance…' : `${balance.toLocaleString()} tokens available`}
        </p>

        <fieldset className="mt-5">
          <legend className="mb-2 text-sm font-medium">Amount</legend>
          <div className="grid grid-cols-4 gap-2">
            {QUICK_AMOUNTS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setAmount(value)}
                aria-pressed={amount === value}
                className={cn(
                  'rounded-sm border py-2.5 text-sm tabular-nums transition-colors',
                  amount === value
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-border hover:bg-surface-raised',
                )}
              >
                {value}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-5">
          <legend className="mb-2 text-sm font-medium">Offer extra time</legend>
          <div className="grid grid-cols-2 gap-2">
            {TIME_OFFERS.map((option) => (
              <button
                key={option.seconds}
                type="button"
                onClick={() => setOfferedSeconds(option.seconds)}
                aria-pressed={offeredSeconds === option.seconds}
                className={cn(
                  'rounded-sm border py-2.5 text-sm transition-colors',
                  offeredSeconds === option.seconds
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-border hover:bg-surface-raised',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {offeredSeconds > 0 && (
            // Set the expectation before they spend, not after they are disappointed.
            <p className="mt-2 text-xs text-muted">
              {partnerName} can accept or decline. Either way they keep the tokens, and
              either of you can still leave at any time.
            </p>
          )}
        </fieldset>

        <label className="mt-5 block text-sm">
          <span className="font-medium">Message (optional)</span>
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={200}
            placeholder="Say something nice"
            className="mt-1.5 w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm placeholder:text-muted/60 focus:border-brand"
          />
        </label>

        {insufficient && (
          <p className="mt-4 rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
            Not enough tokens.{' '}
            <Link href="/settings/tokens" className="underline underline-offset-4">
              Top up
            </Link>
          </p>
        )}

        <p className="mt-4 text-xs text-muted">Tips are final and cannot be refunded.</p>

        <div className="mt-5 flex gap-3">
          <Button variant="secondary" fullWidth onClick={onClose}>
            Cancel
          </Button>
          <Button
            fullWidth
            disabled={insufficient}
            onClick={() => {
              onSend(amount, {
                message: message.trim() || undefined,
                offeredSeconds: offeredSeconds || undefined,
              });
              onClose();
            }}
          >
            Send {amount}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The recipient's Accept / Decline prompt.
 *
 * This is the consent gate. It appears only for the recipient, the tokens have already
 * arrived, and dismissing it changes nothing about their ability to press Next, report or
 * block. It is an invitation, not a toll gate.
 */
export function TipOfferPrompt({
  offer,
  onRespond,
}: {
  offer: TipReceivedPayload;
  onRespond: (tipId: string, accepted: boolean) => void;
}) {
  const minutes = Math.round((offer.offeredSeconds ?? 0) / 60);

  return (
    <div
      role="alertdialog"
      aria-labelledby="offer-title"
      className="absolute inset-x-4 top-20 z-30 mx-auto max-w-sm"
    >
      <div className="glass rounded-lg p-5 shadow-2xl">
        <h2 id="offer-title" className="flex items-center gap-2 font-medium">
          <Gift className="h-5 w-5 shrink-0 text-brand" aria-hidden />
          {offer.fromName} sent you {offer.tokens.toLocaleString()} tokens
        </h2>

        {offer.message && (
          <p className="mt-2 rounded-sm bg-surface-raised px-3 py-2 text-sm text-muted">
            {offer.message}
          </p>
        )}

        <p className="mt-3 flex items-center gap-1.5 text-sm text-muted">
          <Clock className="h-4 w-4 shrink-0" aria-hidden />
          They would like to keep talking for another {minutes} minute
          {minutes === 1 ? '' : 's'}.
        </p>

        {/* Say plainly that declining is free. Someone who feels they have been paid to
            stay is exactly the situation this design exists to prevent. */}
        <p className="mt-2 text-xs text-muted">
          The tokens are yours either way. You can decline, and you can still leave at any
          time.
        </p>

        <div className="mt-4 flex gap-3">
          <Button variant="secondary" fullWidth onClick={() => onRespond(offer.tipId, false)}>
            Decline
          </Button>
          <Button fullWidth onClick={() => onRespond(offer.tipId, true)}>
            Keep talking
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Transient confirmation shown to both sides when a tip lands. */
export function TipToast({ tip }: { tip: TipReceivedPayload }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-32 z-20 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-full border border-brand/40 bg-brand/15 px-4 py-2 text-sm backdrop-blur">
        <Coins className="h-4 w-4 text-brand" aria-hidden />
        {tip.isOwn
          ? `You sent ${tip.tokens.toLocaleString()} tokens`
          : `${tip.fromName} sent you ${tip.tokens.toLocaleString()} tokens`}
      </div>
    </div>
  );
}
