/**
 * Country reference data.
 *
 * Country-level is the finest location granularity Trip2World ever stores or displays —
 * see `docs/SECURITY.md`. Flags are derived from the code rather than shipped as images
 * so there is no asset pipeline and no licensing question.
 */

export interface CountryRecord {
  code: string;
  name: string;
  /** Primary language codes, used to seed a new user's language list. */
  languages: string[];
}

export const COUNTRIES: readonly CountryRecord[] = [
  { code: 'AR', name: 'Argentina', languages: ['es'] },
  { code: 'AT', name: 'Austria', languages: ['de'] },
  { code: 'AU', name: 'Australia', languages: ['en'] },
  { code: 'BE', name: 'Belgium', languages: ['nl', 'fr', 'de'] },
  { code: 'BG', name: 'Bulgaria', languages: ['bg'] },
  { code: 'BR', name: 'Brazil', languages: ['pt'] },
  { code: 'CA', name: 'Canada', languages: ['en', 'fr'] },
  { code: 'CH', name: 'Switzerland', languages: ['de', 'fr', 'it'] },
  { code: 'CL', name: 'Chile', languages: ['es'] },
  { code: 'CO', name: 'Colombia', languages: ['es'] },
  { code: 'CZ', name: 'Czechia', languages: ['cs'] },
  { code: 'DE', name: 'Germany', languages: ['de'] },
  { code: 'DK', name: 'Denmark', languages: ['da'] },
  { code: 'EE', name: 'Estonia', languages: ['et'] },
  { code: 'EG', name: 'Egypt', languages: ['ar'] },
  { code: 'ES', name: 'Spain', languages: ['es'] },
  { code: 'FI', name: 'Finland', languages: ['fi'] },
  { code: 'FR', name: 'France', languages: ['fr'] },
  { code: 'GB', name: 'United Kingdom', languages: ['en'] },
  { code: 'GR', name: 'Greece', languages: ['el'] },
  { code: 'HR', name: 'Croatia', languages: ['hr'] },
  { code: 'HU', name: 'Hungary', languages: ['hu'] },
  { code: 'ID', name: 'Indonesia', languages: ['id'] },
  { code: 'IE', name: 'Ireland', languages: ['en'] },
  { code: 'IL', name: 'Israel', languages: ['he'] },
  { code: 'IN', name: 'India', languages: ['hi', 'en'] },
  { code: 'IS', name: 'Iceland', languages: ['is'] },
  { code: 'IT', name: 'Italy', languages: ['it'] },
  { code: 'JP', name: 'Japan', languages: ['ja'] },
  { code: 'KE', name: 'Kenya', languages: ['en', 'sw'] },
  { code: 'KR', name: 'South Korea', languages: ['ko'] },
  { code: 'LT', name: 'Lithuania', languages: ['lt'] },
  { code: 'LV', name: 'Latvia', languages: ['lv'] },
  { code: 'MA', name: 'Morocco', languages: ['ar', 'fr'] },
  { code: 'MX', name: 'Mexico', languages: ['es'] },
  { code: 'MY', name: 'Malaysia', languages: ['ms', 'en'] },
  { code: 'NG', name: 'Nigeria', languages: ['en'] },
  { code: 'NL', name: 'Netherlands', languages: ['nl'] },
  { code: 'NO', name: 'Norway', languages: ['no'] },
  { code: 'NZ', name: 'New Zealand', languages: ['en'] },
  { code: 'PE', name: 'Peru', languages: ['es'] },
  { code: 'PH', name: 'Philippines', languages: ['en', 'tl'] },
  { code: 'PL', name: 'Poland', languages: ['pl'] },
  { code: 'PT', name: 'Portugal', languages: ['pt'] },
  { code: 'RO', name: 'Romania', languages: ['ro'] },
  { code: 'RS', name: 'Serbia', languages: ['sr'] },
  { code: 'SE', name: 'Sweden', languages: ['sv'] },
  { code: 'SG', name: 'Singapore', languages: ['en'] },
  { code: 'SI', name: 'Slovenia', languages: ['sl'] },
  { code: 'SK', name: 'Slovakia', languages: ['sk'] },
  { code: 'TH', name: 'Thailand', languages: ['th'] },
  { code: 'TR', name: 'Türkiye', languages: ['tr'] },
  { code: 'TW', name: 'Taiwan', languages: ['zh'] },
  { code: 'UA', name: 'Ukraine', languages: ['uk'] },
  { code: 'US', name: 'United States', languages: ['en'] },
  { code: 'UY', name: 'Uruguay', languages: ['es'] },
  { code: 'VN', name: 'Vietnam', languages: ['vi'] },
  { code: 'ZA', name: 'South Africa', languages: ['en', 'af'] },
];

export const COUNTRY_CODES: readonly string[] = COUNTRIES.map((c) => c.code);

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function getCountry(code: string | null | undefined): CountryRecord | null {
  if (!code) return null;
  return COUNTRY_BY_CODE.get(code.toUpperCase()) ?? null;
}

export function isSupportedCountry(code: string | null | undefined): boolean {
  return getCountry(code) !== null;
}

export function countryName(code: string | null | undefined): string | null {
  return getCountry(code)?.name ?? null;
}

/**
 * Regional-indicator emoji flag for an alpha-2 code, e.g. `PT` -> 🇵🇹.
 * Returns an empty string for anything that is not two ASCII letters.
 */
export function countryFlagEmoji(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  const base = 0x1f1e6;
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    base + (upper.charCodeAt(0) - 65),
    base + (upper.charCodeAt(1) - 65),
  );
}

/** Display string used across web and mobile, e.g. "🇵🇹 Portugal". */
export function formatCountry(code: string | null | undefined): string | null {
  const country = getCountry(code);
  if (!country) return null;
  return `${countryFlagEmoji(country.code)} ${country.name}`;
}
