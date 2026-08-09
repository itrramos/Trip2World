'use client';

import { COUNTRIES, MAX_INTERESTS_PER_USER, PREFERRED_COUNTRY_LIMIT } from '@trip2world/shared';
import type { PlanTier } from '@trip2world/types';
import { Button, cn, Field, FormError, Input, Select } from '@trip2world/ui';
import { ArrowLeft, Ban, Check, Coins, Loader2 } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { LanguageSwitcher } from '@/components/language-switcher';
import { useRequireAuth } from '@/components/session-provider';
import { Link } from '@/i18n/navigation';

interface ProfileResponse {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  plan: string;
  displayName: string | null;
  bio: string | null;
  country: string | null;
  gender: string | null;
  languages: string[];
  age: number | null;
  privacy: Record<string, boolean>;
  preferences: {
    preferredGender: string;
    preferredCountries: string[];
    autoRequeue: boolean;
    startMuted: boolean;
    startCameraOff: boolean;
  } | null;
  interests: string[];
}

interface InterestOption {
  id: string;
  slug: string;
  label: string;
  emoji: string | null;
}

interface BlockedEntry {
  id: string;
  blockedAt: string;
  user: { id: string; username: string; displayName: string | null };
}

type Tab = 'profile' | 'privacy' | 'matching' | 'blocked' | 'account';

const TABS: Tab[] = ['profile', 'privacy', 'matching', 'blocked', 'account'];

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const { status } = useRequireAuth();
  const [tab, setTab] = useState<Tab>('profile');
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [interests, setInterests] = useState<InterestOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [me, catalogue] = await Promise.all([
        api.get<ProfileResponse>('/v1/profile'),
        api.get<InterestOption[]>('/v1/profile/interests/catalogue'),
      ]);
      setProfile(me);
      setInterests(catalogue);
    } catch {
      setError(t('loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    if (status === 'authenticated') void load();
  }, [status, load]);

  /** Shared save helper — every tab reports success the same way. */
  const save = useCallback(
    async (fn: () => Promise<ProfileResponse>, label: string) => {
      setError(null);
      try {
        setProfile(await fn());
        setSaved(label);
        // Confirmation fades rather than persisting; a permanent "Saved" is noise.
        setTimeout(() => setSaved(null), 2500);
      } catch (caught) {
        setError(
          caught instanceof ApiRequestError
            ? (Object.values(caught.fieldErrors)[0]?.[0] ?? caught.message)
            : t('saveFailed'),
        );
      }
    },
    [t],
  );

  if (status === 'loading' || !profile) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand" aria-hidden />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href="/discover"
        className="inline-flex items-center gap-2 text-sm text-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {tCommon('back')}
      </Link>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <Link
          href="/settings/tokens"
          className="inline-flex items-center gap-2 rounded-sm border border-border bg-surface px-4 py-2 text-sm hover:bg-surface-raised"
        >
          <Coins className="h-4 w-4 text-brand" aria-hidden />
          {t('tokens')}
        </Link>
      </div>

      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap border-b-2 px-4 py-2.5 text-sm transition-colors',
              tab === id
                ? 'border-brand text-brand'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            {t(`tabs.${id}`)}
          </button>
        ))}
      </div>

      <div className="mt-8 space-y-6">
        {error && <FormError message={error} />}
        {saved && (
          <p className="flex items-center gap-2 rounded-sm border border-success/30 bg-success/10 px-4 py-2.5 text-sm text-success">
            <Check className="h-4 w-4" aria-hidden />
            {saved}
          </p>
        )}

        {tab === 'profile' && (
          <ProfileTab profile={profile} interests={interests} onSave={save} />
        )}
        {tab === 'privacy' && <PrivacyTab profile={profile} onSave={save} />}
        {tab === 'matching' && <MatchingTab profile={profile} onSave={save} />}
        {tab === 'blocked' && <BlockedTab />}
        {tab === 'account' && <AccountTab profile={profile} />}
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */

type SaveFn = (fn: () => Promise<ProfileResponse>, label: string) => Promise<void>;

function ProfileTab({
  profile,
  interests,
  onSave,
}: {
  profile: ProfileResponse;
  interests: InterestOption[];
  onSave: SaveFn;
}) {
  const t = useTranslations('settings.profile');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const [displayName, setDisplayName] = useState(profile.displayName ?? '');
  const [bio, setBio] = useState(profile.bio ?? '');
  const [country, setCountry] = useState(profile.country ?? '');
  const [gender, setGender] = useState(profile.gender ?? 'UNSPECIFIED');
  const [chosen, setChosen] = useState<string[]>(profile.interests);
  const [busy, setBusy] = useState(false);

  const countries = useMemo(
    () => [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [locale],
  );
  const atLimit = chosen.length >= MAX_INTERESTS_PER_USER;

  return (
    <section className="space-y-5">
      <Field label={t('displayName')} htmlFor="displayName" hint={t('displayNameHint')}>
        <Input
          id="displayName"
          value={displayName}
          maxLength={40}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>

      <Field label={t('bio')} htmlFor="bio">
        <textarea
          id="bio"
          value={bio}
          rows={3}
          maxLength={300}
          onChange={(event) => setBio(event.target.value)}
          className="w-full rounded-sm border border-border bg-surface px-3.5 py-2.5 text-sm focus:border-brand"
        />
      </Field>

      <Field label={t('country')} htmlFor="country">
        <Select id="country" value={country} onChange={(event) => setCountry(event.target.value)}>
          {countries.map((item) => (
            <option key={item.code} value={item.code}>
              {item.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={t('gender')} htmlFor="gender">
        <Select id="gender" value={gender} onChange={(event) => setGender(event.target.value)}>
          {(['UNSPECIFIED', 'FEMALE', 'MALE', 'NON_BINARY', 'OTHER'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`genders.${value}`)}
            </option>
          ))}
        </Select>
      </Field>

      {/*
        Language lives here rather than in a header dropdown. It is a preference, it is
        saved to the account alongside the others, and burying it would make the other
        five catalogues effectively unreachable.
      */}
      <Field label={tCommon('language')} htmlFor="locale" hint={t('languageHint')}>
        <LanguageSwitcher id="locale" />
      </Field>

      <fieldset>
        <legend className="text-sm font-medium">
          {t('interests')}{' '}
          <span className="font-normal text-muted">
            {t('counter', { chosen: chosen.length, max: MAX_INTERESTS_PER_USER })}
          </span>
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {interests.map((interest) => {
            const active = chosen.includes(interest.slug);
            return (
              <button
                key={interest.slug}
                type="button"
                aria-pressed={active}
                // Disabling unselected chips at the cap is clearer than letting someone
                // click and then rejecting it.
                disabled={!active && atLimit}
                onClick={() =>
                  setChosen((previous) =>
                    active
                      ? previous.filter((slug) => slug !== interest.slug)
                      : [...previous, interest.slug],
                  )
                }
                className={cn(
                  'rounded-full border px-3.5 py-1.5 text-sm transition-colors disabled:opacity-40',
                  active ? 'border-brand bg-brand/10 text-brand' : 'border-border hover:bg-surface-raised',
                )}
              >
                {interest.emoji && <span className="mr-1.5">{interest.emoji}</span>}
                {interest.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <Button
        loading={busy}
        onClick={() => {
          setBusy(true);
          void onSave(async () => {
            await api.patch<ProfileResponse>('/v1/profile', {
              displayName: displayName.trim() || null,
              bio: bio.trim() || null,
              country,
              gender,
            });
            return api.put<ProfileResponse>('/v1/profile/interests', { interests: chosen });
          }, t('saved')).finally(() => setBusy(false));
        }}
      >
        {t('save')}
      </Button>
    </section>
  );
}

/** Toggle keys, in display order. Those with an explanatory hint are listed here. */
const PRIVACY_TOGGLES = [
  { key: 'showDisplayName', hint: true },
  { key: 'showCountry', hint: true },
  { key: 'showAgeBracket', hint: true },
  { key: 'showGender', hint: false },
  { key: 'showInterests', hint: false },
  { key: 'showBio', hint: false },
  { key: 'allowConnectionRequests', hint: true },
] as const;

function PrivacyTab({ profile, onSave }: { profile: ProfileResponse; onSave: SaveFn }) {
  const t = useTranslations('settings.privacy');
  const [values, setValues] = useState(profile.privacy);
  const [busy, setBusy] = useState(false);

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted">{t('intro')}</p>

      {PRIVACY_TOGGLES.map((toggle) => (
        <label
          key={toggle.key}
          className="flex cursor-pointer items-start justify-between gap-4 rounded-sm border border-border p-4"
        >
          <span>
            <span className="text-sm font-medium">{t(toggle.key)}</span>
            {toggle.hint && (
              <span className="mt-0.5 block text-xs text-muted">{t(`${toggle.key}Hint`)}</span>
            )}
          </span>
          <input
            type="checkbox"
            checked={values[toggle.key] ?? true}
            onChange={(event) =>
              setValues((previous) => ({ ...previous, [toggle.key]: event.target.checked }))
            }
            className="mt-0.5 h-5 w-5 shrink-0 accent-brand"
          />
        </label>
      ))}

      <Button
        loading={busy}
        onClick={() => {
          setBusy(true);
          void onSave(
            () => api.patch<ProfileResponse>('/v1/profile/privacy', values),
            t('saved'),
          ).finally(() => setBusy(false));
        }}
      >
        {t('save')}
      </Button>
    </section>
  );
}

function MatchingTab({ profile, onSave }: { profile: ProfileResponse; onSave: SaveFn }) {
  const t = useTranslations('settings.matching');
  const locale = useLocale();
  const preferences = profile.preferences;
  const [preferredGender, setPreferredGender] = useState(preferences?.preferredGender ?? 'ANY');
  const [preferredCountries, setPreferredCountries] = useState<string[]>(
    preferences?.preferredCountries ?? [],
  );
  const [autoRequeue, setAutoRequeue] = useState(preferences?.autoRequeue ?? true);
  const [startMuted, setStartMuted] = useState(preferences?.startMuted ?? false);
  const [startCameraOff, setStartCameraOff] = useState(preferences?.startCameraOff ?? false);
  const [busy, setBusy] = useState(false);

  const limit = PREFERRED_COUNTRY_LIMIT[profile.plan as PlanTier] ?? 1;
  const countries = useMemo(
    () => [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [locale],
  );

  return (
    <section className="space-y-5">
      <Field label={t('wantToMeet')} htmlFor="preferredGender">
        <Select
          id="preferredGender"
          value={preferredGender}
          onChange={(event) => setPreferredGender(event.target.value)}
        >
          <option value="ANY">{t('anyone')}</option>
          <option value="FEMALE">{t('women')}</option>
          <option value="MALE">{t('men')}</option>
        </Select>
      </Field>

      <fieldset>
        <legend className="text-sm font-medium">
          {t('preferredCountries')}{' '}
          <span className="font-normal text-muted">
            {t('counter', { chosen: preferredCountries.length, max: limit })}
          </span>
        </legend>
        {/* Explain the relaxation behaviour, or an empty result looks like a bug. */}
        <p className="mt-1 text-xs text-muted">{t('relaxationHint')}</p>
        <div className="mt-3 flex max-h-56 flex-wrap gap-2 overflow-y-auto rounded-sm border border-border p-3">
          {countries.map((item) => {
            const active = preferredCountries.includes(item.code);
            return (
              <button
                key={item.code}
                type="button"
                aria-pressed={active}
                disabled={!active && preferredCountries.length >= limit}
                onClick={() =>
                  setPreferredCountries((previous) =>
                    active
                      ? previous.filter((code) => code !== item.code)
                      : [...previous, item.code],
                  )
                }
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-30',
                  active ? 'border-brand bg-brand/10 text-brand' : 'border-border hover:bg-surface-raised',
                )}
              >
                {item.name}
              </button>
            );
          })}
        </div>
      </fieldset>

      {[
        { key: 'autoRequeue', checked: autoRequeue, set: setAutoRequeue },
        { key: 'startMuted', checked: startMuted, set: setStartMuted },
        { key: 'startCameraOff', checked: startCameraOff, set: setStartCameraOff },
      ].map((toggle) => (
        <label
          key={toggle.key}
          className="flex cursor-pointer items-center justify-between gap-4 rounded-sm border border-border p-4 text-sm"
        >
          {t(toggle.key)}
          <input
            type="checkbox"
            checked={toggle.checked}
            onChange={(event) => toggle.set(event.target.checked)}
            className="h-5 w-5 shrink-0 accent-brand"
          />
        </label>
      ))}

      <Button
        loading={busy}
        onClick={() => {
          setBusy(true);
          void onSave(
            () =>
              api.patch<ProfileResponse>('/v1/profile/preferences', {
                preferredGender,
                preferredCountries,
                autoRequeue,
                startMuted,
                startCameraOff,
              }),
            t('saved'),
          ).finally(() => setBusy(false));
        }}
      >
        {t('save')}
      </Button>
    </section>
  );
}

function BlockedTab() {
  const t = useTranslations('settings.blocked');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const [blocked, setBlocked] = useState<BlockedEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ items: BlockedEntry[] }>('/v1/blocks');
      setBlocked(data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="text-sm text-muted">{tCommon('loading')}</p>;

  if (blocked.length === 0) {
    return (
      <div className="rounded-lg border border-border p-8 text-center">
        <Ban className="mx-auto mb-3 h-7 w-7 text-muted" aria-hidden />
        <p className="text-sm font-medium">{t('emptyTitle')}</p>
        <p className="mt-1 text-sm text-muted">{t('emptyBody')}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {blocked.map((entry) => (
        <li
          key={entry.id}
          className="flex items-center justify-between gap-4 rounded-sm border border-border p-4"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">
              {entry.user.displayName ?? entry.user.username}
            </span>
            <span className="text-xs text-muted">
              {t('blockedOn', {
                date: format.dateTime(new Date(entry.blockedAt), { dateStyle: 'medium' }),
              })}
            </span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void api
                .delete('/v1/blocks', { body: { userId: entry.user.id } })
                .then(() => load());
            }}
          >
            {t('unblock')}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The literal word the user must type to confirm deletion.
 *
 * Deliberately NOT translated. The API compares the submitted value against this exact
 * string, so a translated sentinel would make the form impossible to complete in that
 * language — the button would simply never enable. It is interpolated into the label so
 * a translator can still write a natural sentence around it.
 */
const DELETE_CONFIRMATION = 'DELETE';

function AccountTab({ profile }: { profile: ProfileResponse }) {
  const t = useTranslations('settings.account');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduled, setScheduled] = useState<string | null>(null);

  if (scheduled) {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-5 text-sm">
        <p className="font-medium text-warning">{t('scheduledTitle')}</p>
        <p className="mt-2 text-muted">
          {t('scheduledBody', {
            date: format.dateTime(new Date(scheduled), { dateStyle: 'long' }),
          })}
        </p>
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <dl className="space-y-2 rounded-sm border border-border p-4 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted">{t('username')}</dt>
          <dd>{profile.username}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">{t('email')}</dt>
          <dd className="text-right">
            {profile.email}
            {!profile.emailVerified && (
              <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
                {t('unverified')}
              </span>
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">{t('age')}</dt>
          <dd>{profile.age ?? '—'}</dd>
        </div>
      </dl>

      <div className="rounded-lg border border-danger/30 p-5">
        <h2 className="font-medium text-danger">{t('deleteTitle')}</h2>
        <p className="mt-2 text-sm text-muted">
          {t.rich('deleteBody', {
            link: (chunks) => (
              <Link href="/privacy" className="underline underline-offset-4">
                {chunks}
              </Link>
            ),
          })}
        </p>

        {!confirming ? (
          <Button variant="danger" className="mt-4" onClick={() => setConfirming(true)}>
            {t('delete')}
          </Button>
        ) : (
          <div className="mt-4 space-y-3">
            {error && <FormError message={error} />}
            <Field label={t('password')} htmlFor="delete-password">
              <Input
                id="delete-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Field
              label={t('typeToConfirm', { word: DELETE_CONFIRMATION })}
              htmlFor="delete-confirm"
            >
              <Input
                id="delete-confirm"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </Field>
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                {tCommon('cancel')}
              </Button>
              <Button
                variant="danger"
                loading={busy}
                disabled={confirmation !== DELETE_CONFIRMATION}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void api
                    .post<{ scheduledFor: string }>('/v1/auth/delete-account', {
                      password,
                      confirmation,
                    })
                    .then((result) => setScheduled(result.scheduledFor))
                    .catch((caught: unknown) =>
                      setError(
                        caught instanceof ApiRequestError ? caught.message : t('deleteFailed'),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {t('confirmDelete')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
