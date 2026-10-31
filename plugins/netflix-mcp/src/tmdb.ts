import { readFileSync } from "node:fs";
import { API_KEY_PATH, AUTH_HINT } from "./config.js";

const BASE = "https://api.themoviedb.org/3";
// TMDB provider ids: 8 = Netflix, 1796 = Netflix Standard with Ads.
const NETFLIX_STANDARD = 8;
const NETFLIX_ADS = 1796;
const MAX_OVERVIEW_CHARS = 200;

export type MediaType = "movie" | "tv";
export interface Tiers {
  standard: boolean;
  ads: boolean;
}

function credential(): string {
  const env = process.env.TMDB_API_KEY?.trim();
  if (env) return env;
  try {
    const v = readFileSync(API_KEY_PATH, "utf8").trim();
    if (v) return v;
  } catch {
    // fall through to the error below
  }
  throw new Error(
    `No TMDB credential. Run the netflix-setup skill, or ask the user to run: ${AUTH_HINT} (saves the key to ${API_KEY_PATH}).`,
  );
}

// v4 read access tokens are JWTs sent as a bearer header; v3 keys are 32 hex chars passed as a query param.
function authorize(url: URL, cred: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (cred.startsWith("eyJ")) headers.authorization = `Bearer ${cred}`;
  else url.searchParams.set("api_key", cred);
  return headers;
}

/** True if TMDB accepts the credential; used by auth.ts before saving it. */
export async function verifyCredential(cred: string): Promise<boolean> {
  const url = new URL(`${BASE}/authentication`);
  const res = await fetch(url, { headers: authorize(url, cred), signal: AbortSignal.timeout(15_000) });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`TMDB check failed (${res.status}); try again later.`);
  return true;
}

async function get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const cred = credential();
  const url = new URL(BASE + path);
  const headers = authorize(url, cred);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  // Errors name only the path: the URL may carry the api_key.
  if (res.status === 401) throw new Error(`TMDB rejected the credential in ${API_KEY_PATH} (401). Run the netflix-setup skill to replace it.`);
  if (!res.ok) throw new Error(`TMDB request failed (${res.status}) for ${path}`);
  return (await res.json()) as T;
}

export function normalizeCountry(code: string): string {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw new Error(`Invalid country "${code}": use an ISO 3166-1 alpha-2 code such as US, JP, GB.`);
  return c;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryName = (code: string) => regionNames.of(code) ?? code;

interface Provider {
  provider_id: number;
}
interface Region {
  flatrate?: Provider[];
  ads?: Provider[];
}

/** Country code -> which Netflix tiers carry the title, for every country where at least one does. */
async function netflixCountries(type: MediaType, id: number): Promise<Record<string, Tiers>> {
  const data = await get<{ results?: Record<string, Region> }>(`/${type}/${id}/watch/providers`);
  const out: Record<string, Tiers> = {};
  for (const [code, region] of Object.entries(data.results ?? {})) {
    const ids = new Set([...(region.flatrate ?? []), ...(region.ads ?? [])].map((p) => p.provider_id));
    const tiers = { standard: ids.has(NETFLIX_STANDARD), ads: ids.has(NETFLIX_ADS) };
    if (tiers.standard || tiers.ads) out[code] = tiers;
  }
  return out;
}

interface RawTitle {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  overview?: string;
}

function summarize(t: RawTitle, type: MediaType) {
  const date = type === "movie" ? t.release_date : t.first_air_date;
  const overview = (t.overview ?? "").trim();
  return {
    tmdb_id: t.id,
    media_type: type,
    title: (type === "movie" ? t.title : t.name) ?? "",
    year: date ? date.slice(0, 4) : null,
    rating: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    overview: overview.length > MAX_OVERVIEW_CHARS ? overview.slice(0, MAX_OVERVIEW_CHARS) + "…" : overview,
  };
}

export async function searchTitles(query: string, type: MediaType | "all", country: string, max: number) {
  const data = await get<{ results: RawTitle[] }>(type === "all" ? "/search/multi" : `/search/${type}`, {
    query,
    include_adult: false,
  });
  const hits = data.results
    .map((t) => ({ t, type: (type === "all" ? t.media_type : type) as string }))
    .filter((h): h is { t: RawTitle; type: MediaType } => h.type === "movie" || h.type === "tv")
    .slice(0, max);
  const availability = await Promise.all(hits.map((h) => netflixCountries(h.type, h.t.id)));
  const results = hits.map((h, i) => {
    const countries = availability[i]!;
    const base = summarize(h.t, h.type);
    if (country) {
      const tiers = countries[country];
      return { ...base, netflix_standard: tiers?.standard ?? false, netflix_ads: tiers?.ads ?? false };
    }
    const codes = Object.keys(countries).sort();
    const adCodes = codes.filter((c) => countries[c]!.ads);
    return {
      ...base,
      netflix_country_count: codes.length,
      netflix_countries: codes.join(","),
      netflix_ads_countries: adCodes.join(","),
    };
  });
  return country ? results.filter((r) => "netflix_standard" in r && (r.netflix_standard || r.netflix_ads)) : results;
}

export async function checkAvailability(type: MediaType, id: number) {
  const [detail, countries] = await Promise.all([
    get<RawTitle>(`/${type}/${id}`),
    netflixCountries(type, id),
  ]);
  const list = Object.entries(countries)
    .map(([code, tiers]) => ({ code, country: countryName(code), ...tiers }))
    .sort((a, b) => a.country.localeCompare(b.country));
  return { ...summarize(detail, type), country_count: list.length, countries: list };
}

const genreCache = new Map<MediaType, Map<string, number>>();

async function genreId(type: MediaType, name: string): Promise<number> {
  let genres = genreCache.get(type);
  if (!genres) {
    const data = await get<{ genres: { id: number; name: string }[] }>(`/genre/${type}/list`, { language: "en-US" });
    genres = new Map(data.genres.map((g) => [g.name.toLowerCase(), g.id]));
    genreCache.set(type, genres);
  }
  const id = genres.get(name.trim().toLowerCase());
  if (id === undefined) throw new Error(`Unknown ${type} genre "${name}". Valid: ${[...genres.keys()].join(", ")}.`);
  return id;
}

export interface BrowseOptions {
  country: string;
  type: MediaType;
  genre: string;
  originCountry: string;
  year: number | undefined;
  sortBy: string;
  page: number;
}

export async function browseCountry(o: BrowseOptions) {
  const data = await get<{ page: number; total_pages: number; total_results: number; results: RawTitle[] }>(
    `/discover/${o.type}`,
    {
      watch_region: o.country,
      with_watch_providers: `${NETFLIX_STANDARD}|${NETFLIX_ADS}`,
      with_watch_monetization_types: "flatrate|ads",
      with_genres: o.genre ? await genreId(o.type, o.genre) : undefined,
      with_origin_country: o.originCountry || undefined,
      [o.type === "movie" ? "primary_release_year" : "first_air_date_year"]: o.year,
      sort_by: o.sortBy,
      page: o.page,
      include_adult: false,
      language: "en-US",
    },
  );
  return {
    country: o.country,
    page: data.page,
    total_pages: Math.min(data.total_pages, 500), // TMDB serves at most 500 pages
    total_results: data.total_results,
    results: data.results.map((t) => summarize(t, o.type)),
  };
}

/** Countries where TMDB lists Netflix, from each provider's display_priorities map; ad_plan marks those with the ad tier. */
export async function listCountries(adPlanOnly: boolean) {
  const data = await get<{ results: { provider_id: number; display_priorities?: Record<string, number> }[] }>(
    "/watch/providers/movie",
  );
  const codesOf = (id: number) => Object.keys(data.results.find((p) => p.provider_id === id)?.display_priorities ?? {});
  const adCodes = new Set(codesOf(NETFLIX_ADS));
  const list = [...new Set([...codesOf(NETFLIX_STANDARD), ...adCodes])]
    .sort()
    .map((code) => ({ code, country: countryName(code), ad_plan: adCodes.has(code) }))
    .filter((c) => !adPlanOnly || c.ad_plan);
  return { count: list.length, countries: list };
}
