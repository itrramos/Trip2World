'use client';

import { Button, cn, Field, FormError, Input, Select } from '@trip2world/ui';
import { Coins, Gift, Pause, Play, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { useAdminSession } from '@/components/admin-session';
import { Shell } from '@/components/shell';

/**
 * Promotional token grants.
 *
 * The screen is built around one idea: **switching a campaign on spends money.** Tokens
 * are bought with cards, so a grant is an outgoing budget, and the interface should feel
 * like it. Hence: campaigns are created stopped, the amount is locked once anyone has
 * received it, and the live ones are separated from the rest rather than sorted among
 * them.
 */

type Audience = 'NEW_USERS' | 'ALL_USERS';
type Status = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED';

interface Campaign {
  id: string;
  name: string;
  description: string | null;
  tokens: number;
  audience: Audience;
  status: Status;
  startsAt: string | null;
  endsAt: string | null;
  maxGrants: number | null;
  grantsIssued: number;
  requiresVerifiedEmail: boolean;
  createdAt: string;
  createdBy: { id: string; username: string } | null;
}

const STATUS_STYLE: Record<Status, string> = {
  DRAFT: 'bg-surface-raised text-muted',
  ACTIVE: 'bg-success/15 text-success',
  PAUSED: 'bg-warning/15 text-warning',
  ENDED: 'bg-surface-raised text-muted',
};

const AUDIENCE_LABEL: Record<Audience, string> = {
  NEW_USERS: 'New accounts',
  ALL_USERS: 'Everyone, on next sign-in',
};

export default function CampaignsPage() {
  const { status } = useAdminSession();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCampaigns(await api.get<Campaign[]>('/v1/admin/campaigns'));
    } catch {
      setError('Could not load campaigns.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'authenticated') void load();
  }, [status, load]);

  async function setStatus(campaign: Campaign, next: Status) {
    setBusyId(campaign.id);
    setError(null);
    try {
      await api.post(`/v1/admin/campaigns/${campaign.id}/status`, { status: next });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not update.');
    } finally {
      setBusyId(null);
    }
  }

  const live = campaigns.filter((c) => c.status === 'ACTIVE');
  const rest = campaigns.filter((c) => c.status !== 'ACTIVE');

  return (
    <Shell>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Promotions</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Grant free tokens automatically — a launch bonus, a special day, or the first N
            accounts. Each user receives a given promotion once, and only after confirming
            their email address unless you turn that off.
          </p>
        </div>
        <Button onClick={() => setCreating((open) => !open)}>
          {creating ? 'Cancel' : 'New promotion'}
        </Button>
      </div>

      {error && <FormError message={error} />}

      {creating && (
        <CampaignForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-lg border border-border p-10 text-center">
          <Gift className="mx-auto mb-3 h-7 w-7 text-muted" aria-hidden />
          <p className="text-sm font-medium">No promotions yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            A promotion grants tokens to users automatically while it is running. Nothing is
            granted until you switch one on.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {live.length > 0 && (
            <section>
              {/* Live campaigns are separated rather than sorted, because "what is
                  spending money right now" is the question this page exists to answer. */}
              <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-success">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                </span>
                Running now
              </h2>
              <div className="space-y-3">
                {live.map((campaign) => (
                  <CampaignRow
                    key={campaign.id}
                    campaign={campaign}
                    busy={busyId === campaign.id}
                    onStatus={setStatus}
                  />
                ))}
              </div>
            </section>
          )}

          {rest.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-medium text-muted">Not running</h2>
              <div className="space-y-3">
                {rest.map((campaign) => (
                  <CampaignRow
                    key={campaign.id}
                    campaign={campaign}
                    busy={busyId === campaign.id}
                    onStatus={setStatus}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Shell>
  );
}

/* -------------------------------------------------------------------------- */

function CampaignRow({
  campaign,
  busy,
  onStatus,
}: {
  campaign: Campaign;
  busy: boolean;
  onStatus: (campaign: Campaign, next: Status) => void;
}) {
  const capped = campaign.maxGrants !== null;
  const exhausted = capped && campaign.grantsIssued >= campaign.maxGrants!;
  const spent = campaign.grantsIssued * campaign.tokens;

  return (
    <div className="rounded-lg border border-border p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{campaign.name}</h3>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                STATUS_STYLE[campaign.status],
              )}
            >
              {campaign.status.toLowerCase()}
            </span>
            {exhausted && campaign.status === 'ACTIVE' && (
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
                limit reached
              </span>
            )}
          </div>

          {campaign.description && (
            <p className="mt-1 text-sm text-muted">{campaign.description}</p>
          )}

          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
            <div className="flex gap-1.5">
              <dt>Grant</dt>
              <dd className="tabular-nums text-foreground">
                {campaign.tokens.toLocaleString()} tokens
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Audience</dt>
              <dd className="text-foreground">{AUDIENCE_LABEL[campaign.audience]}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Claimed</dt>
              <dd className="tabular-nums text-foreground">
                {campaign.grantsIssued.toLocaleString()}
                {capped && ` / ${campaign.maxGrants!.toLocaleString()}`}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Granted</dt>
              {/* The number that matters. Tokens are bought with real money. */}
              <dd className="flex items-center gap-1 tabular-nums text-foreground">
                <Coins className="h-3 w-3 text-brand" aria-hidden />
                {spent.toLocaleString()}
              </dd>
            </div>
            {campaign.startsAt && (
              <div className="flex gap-1.5">
                <dt>From</dt>
                <dd className="text-foreground">
                  {new Date(campaign.startsAt).toLocaleString()}
                </dd>
              </div>
            )}
            {campaign.endsAt && (
              <div className="flex gap-1.5">
                <dt>Until</dt>
                <dd className="text-foreground">{new Date(campaign.endsAt).toLocaleString()}</dd>
              </div>
            )}
            {!campaign.requiresVerifiedEmail && (
              <div className="text-warning">Unverified accounts included</div>
            )}
          </dl>
        </div>

        <div className="flex shrink-0 gap-2">
          {campaign.status !== 'ENDED' && campaign.status !== 'ACTIVE' && (
            <Button size="sm" disabled={busy} onClick={() => onStatus(campaign, 'ACTIVE')}>
              <Play className="h-3.5 w-3.5" aria-hidden />
              Start
            </Button>
          )}
          {campaign.status === 'ACTIVE' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onStatus(campaign, 'PAUSED')}
            >
              <Pause className="h-3.5 w-3.5" aria-hidden />
              Pause
            </Button>
          )}
          {campaign.status !== 'ENDED' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              // End is irreversible on the server. Say so rather than letting an admin
              // discover it by trying to restart one.
              title="Ends the promotion permanently. It cannot be restarted."
              onClick={() => onStatus(campaign, 'ENDED')}
            >
              <Square className="h-3.5 w-3.5" aria-hidden />
              End
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function CampaignForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tokens, setTokens] = useState('50');
  const [audience, setAudience] = useState<Audience>('NEW_USERS');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [maxGrants, setMaxGrants] = useState('');
  const [requiresVerifiedEmail, setRequiresVerifiedEmail] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const amount = Number(tokens);
  const cap = maxGrants ? Number(maxGrants) : null;
  const worstCase = cap !== null && Number.isFinite(amount) ? cap * amount : null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/admin/campaigns', {
        name: name.trim(),
        description: description.trim() || undefined,
        tokens: amount,
        audience,
        // datetime-local has no timezone; the browser's own offset is the right
        // interpretation, since the admin typed it in their local time.
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        maxGrants: cap,
        requiresVerifiedEmail,
      });
      onCreated();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? (Object.values(caught.fieldErrors)[0]?.[0] ?? caught.message)
          : 'Could not create the promotion.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-8 rounded-lg border border-border p-6">
      <h2 className="font-medium">New promotion</h2>
      <p className="mt-1 text-sm text-muted">
        Created stopped. Nothing is granted until you start it.
      </p>

      <div className="mt-5 space-y-5">
        {error && <FormError message={error} />}

        <Field label="Name" htmlFor="name" hint="Shown to the user when the tokens arrive.">
          <Input
            id="name"
            value={name}
            maxLength={80}
            placeholder="Launch bonus"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Internal note" htmlFor="description" hint="Never shown to users.">
          <Input
            id="description"
            value={description}
            maxLength={300}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Tokens per user" htmlFor="tokens">
            <Input
              id="tokens"
              type="number"
              min={1}
              value={tokens}
              onChange={(event) => setTokens(event.target.value)}
            />
          </Field>

          <Field
            label="Maximum recipients"
            htmlFor="maxGrants"
            hint="Blank for unlimited. This is the “first N accounts” limit."
          >
            <Input
              id="maxGrants"
              type="number"
              min={1}
              value={maxGrants}
              placeholder="Unlimited"
              onChange={(event) => setMaxGrants(event.target.value)}
            />
          </Field>
        </div>

        {/*
          Show the worst case before they commit. A promotion is a budget, and the
          number an operator actually needs is amount × cap — which is easy to get
          wrong by a factor of ten when typing two separate fields.
        */}
        {worstCase !== null && worstCase > 0 && (
          <p className="flex items-center gap-2 rounded-sm border border-brand/30 bg-brand/10 px-4 py-2.5 text-sm">
            <Coins className="h-4 w-4 shrink-0 text-brand" aria-hidden />
            Grants up to <strong className="tabular-nums">{worstCase.toLocaleString()}</strong>{' '}
            tokens in total.
          </p>
        )}
        {worstCase === null && amount > 0 && (
          <p className="rounded-sm border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
            No recipient limit — this grants {amount.toLocaleString()} tokens to every eligible
            user, with no ceiling.
          </p>
        )}

        <Field label="Who receives it" htmlFor="audience">
          <Select
            id="audience"
            value={audience}
            onChange={(event) => setAudience(event.target.value as Audience)}
          >
            <option value="NEW_USERS">New accounts created while it runs</option>
            <option value="ALL_USERS">Everyone, the next time they sign in</option>
          </Select>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Starts" htmlFor="startsAt" hint="Blank to start as soon as you switch it on.">
            <Input
              id="startsAt"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </Field>
          <Field label="Ends" htmlFor="endsAt" hint="Blank to run until you stop it.">
            <Input
              id="endsAt"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </Field>
        </div>

        <label className="flex cursor-pointer items-start justify-between gap-4 rounded-sm border border-border p-4">
          <span>
            <span className="text-sm font-medium">Require a confirmed email address</span>
            <span className="mt-0.5 block text-xs text-muted">
              Strongly recommended. Free tokens are an incentive to create accounts in bulk;
              requiring verification makes each one cost a working mailbox.
            </span>
          </span>
          <input
            type="checkbox"
            checked={requiresVerifiedEmail}
            onChange={(event) => setRequiresVerifiedEmail(event.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
          />
        </label>

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!name.trim() || !Number.isFinite(amount) || amount < 1}
            onClick={() => void submit()}
          >
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}
