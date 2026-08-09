'use client';

import { Button, cn } from '@trip2world/ui';
import { ArrowLeft, Coins, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { useRequireAuth } from '@/components/session-provider';

interface Balance {
  balance: number;
  lifetimeEarned: number;
  lifetimePurchased: number;
}

interface TokenPackage {
  id: string;
  slug: string;
  tokens: number;
  priceCents: number;
  currency: string;
  label: string | null;
}

interface LedgerEntry {
  id: string;
  delta: number;
  kind: string;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  PURCHASE: 'Tokens purchased',
  TIP_SENT: 'Tip sent',
  TIP_RECEIVED: 'Tip received',
  REFUND: 'Refund',
  ADJUSTMENT: 'Adjustment',
  PROMO: 'Promotional credit',
};

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

function TokensSettings() {
  const { status } = useRequireAuth();
  const params = useSearchParams();

  const [balance, setBalance] = useState<Balance | null>(null);
  const [packages, setPackages] = useState<TokenPackage[]>([]);
  const [purchasingEnabled, setPurchasingEnabled] = useState(false);
  const [history, setHistory] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const purchaseResult = params.get('purchase');

  const load = useCallback(async () => {
    try {
      const [balanceData, packageData, historyData] = await Promise.all([
        api.get<Balance>('/v1/tokens/balance'),
        api.get<{ packages: TokenPackage[]; purchasingEnabled: boolean }>('/v1/tokens/packages'),
        api.get<{ items: LedgerEntry[] }>('/v1/tokens/history?pageSize=50'),
      ]);
      setBalance(balanceData);
      setPackages(packageData.packages);
      setPurchasingEnabled(packageData.purchasingEnabled);
      setHistory(historyData.items);
    } catch {
      setError('Could not load your token balance.');
    }
  }, []);

  useEffect(() => {
    if (status === 'authenticated') void load();
  }, [status, load]);

  /**
   * After returning from checkout, poll briefly.
   *
   * The balance is credited by the Stripe webhook, not by this redirect, so it can arrive
   * a second or two after the browser gets back. Without this the page shows the old
   * balance and the purchase looks like it failed.
   */
  useEffect(() => {
    if (purchaseResult !== 'success') return;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      void load();
      if (attempts >= 5) clearInterval(interval);
    }, 2000);
    return () => clearInterval(interval);
  }, [purchaseResult, load]);

  async function buy(pkg: TokenPackage) {
    setBusySlug(pkg.slug);
    setError(null);
    try {
      const { checkoutUrl } = await api.post<{ checkoutUrl: string }>('/v1/tokens/checkout', {
        packageId: pkg.id,
      });
      window.location.href = checkoutUrl;
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Could not start checkout.',
      );
      setBusySlug(null);
    }
  }

  if (status === 'loading' || !balance) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand" aria-hidden />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/settings"
        className="inline-flex items-center gap-2 text-sm text-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Settings
      </Link>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Tokens</h1>

      {purchaseResult === 'success' && (
        <p className="mt-5 rounded-sm border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          Payment received. Your balance updates within a few seconds.
        </p>
      )}
      {purchaseResult === 'cancelled' && (
        <p className="mt-5 rounded-sm border border-border bg-surface px-4 py-3 text-sm text-muted">
          Checkout cancelled. Nothing was charged.
        </p>
      )}
      {error && (
        <p className="mt-5 rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="glass mt-6 rounded-lg p-6">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Coins className="h-4 w-4 text-brand" aria-hidden />
          Your balance
        </p>
        <p className="mt-2 text-4xl font-semibold tabular-nums">
          {balance.balance.toLocaleString()}
        </p>
        <p className="mt-2 text-xs text-muted">
          {balance.lifetimePurchased.toLocaleString()} purchased ·{' '}
          {balance.lifetimeEarned.toLocaleString()} received from tips
        </p>
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-medium">Buy tokens</h2>

        {!purchasingEnabled ? (
          // Honest about the reason rather than showing a button that fails.
          <p className="mt-3 rounded-sm border border-border bg-surface px-4 py-3 text-sm text-muted">
            Buying tokens is not available on this deployment yet.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {packages.map((pkg) => (
              <button
                key={pkg.id}
                type="button"
                onClick={() => void buy(pkg)}
                disabled={busySlug !== null}
                className={cn(
                  'flex items-center justify-between rounded-lg border p-5 text-left transition-colors',
                  'border-border hover:border-brand hover:bg-surface-raised',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
              >
                <span>
                  <span className="block text-xl font-semibold tabular-nums">
                    {pkg.tokens.toLocaleString()}
                  </span>
                  <span className="text-xs text-muted">tokens</span>
                  {pkg.label && (
                    <span className="ml-2 rounded-full bg-brand/15 px-2 py-0.5 text-xs text-brand">
                      {pkg.label}
                    </span>
                  )}
                </span>
                <span className="text-right">
                  <span className="block font-medium">
                    {formatPrice(pkg.priceCents, pkg.currency)}
                  </span>
                  {busySlug === pkg.slug && (
                    <Loader2 className="ml-auto mt-1 h-4 w-4 animate-spin text-brand" aria-hidden />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}

        <p className="mt-4 text-xs text-muted">
          Tokens have no cash value and cannot be withdrawn. Tips are final and cannot be
          refunded once sent. See the{' '}
          <Link href="/terms" className="underline underline-offset-4">
            Terms
          </Link>
          .
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">History</h2>

        {history.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {history.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="min-w-0">
                  <span className="block text-sm">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
                  <span className="text-xs text-muted">
                    {new Date(entry.createdAt).toLocaleString()}
                    {entry.note && ` · ${entry.note}`}
                  </span>
                </span>
                <span className="text-right">
                  <span
                    className={cn(
                      'block text-sm font-medium tabular-nums',
                      entry.delta > 0 ? 'text-success' : 'text-foreground',
                    )}
                  >
                    {entry.delta > 0 ? '+' : ''}
                    {entry.delta.toLocaleString()}
                  </span>
                  <span className="text-xs tabular-nums text-muted">
                    {entry.balanceAfter.toLocaleString()}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export default function TokensPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      <TokensSettings />
    </Suspense>
  );
}
