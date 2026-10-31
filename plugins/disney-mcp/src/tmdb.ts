import { readFileSync } from "node:fs";
import { API_KEY_PATH, AUTH_HINT } from "./config.js";

const BASE = "https://api.themoviedb.org/3";
// TMDB provider ids: 337 = Disney Plus, 122 = Disney+ (legacy Hotstar-branded entry in GB, ID, IN, MY, TH).
// JioHotstar (2336, India) is a different service and is deliberately excluded. TMDB has no separate
// provider for the ad-supported tier, so this plugin cannot report it.
const DISNEY_IDS = [337, 122];
const DISNEY_FILTER = DISNEY_IDS.join("|"); // "|" is OR in TMDB discover
const MAX_OVERVIEW_CHARS = 200;

export type MediaType = "movie" | "tv";

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
    `No TMDB credential. Run the disney-setup skill, or ask the user to run: ${AUTH_HINT} (saves the key to ${API_KEY_PATH}).`,
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
  if (res.status === 401) throw new Error(`TMDB rejected the credential in ${API_KEY_PATH} (401). Run the disney-setup skill to replace it.`);
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
}

/** Codes of every country where Disney+ carries the title. */
async function disneyCountries(type: MediaType, id: number): Promise<string[]> {
  const data = await get<{ results?: Record<string, Region> }>(`/${type}/${id}/watch/providers`);
  return Object.entries(data.results ?? {})
    .filter(([, region]) => (region.flatrate ?? []).some((p) => DISNEY_IDS.includes(p.provider_id)))
    .map(([code]) => code)
    .sort();
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
  const availability = await Promise.all(hits.map((h) => disneyCountries(h.type, h.t.id)));
  const results = hits.map((h, i) => {
    const codes = availability[i]!;
    const base = summarize(h.t, h.type);
    if (country) return { ...base, on_disney_plus: codes.includes(country) };
    return { ...base, disney_country_count: codes.length, disney_countries: codes.join(",") };
  });
  return country ? results.filter((r) => "on_disney_plus" in r && r.on_disney_plus) : results;
}

export async function checkAvailability(type: MediaType, id: number) {
  const [detail, codes] = await Promise.all([get<RawTitle>(`/${type}/${id}`), disneyCountries(type, id)]);
  const countries = codes
    .map((code) => ({ code, country: countryName(code) }))
    .sort((a, b) => a.country.localeCompare(b.country));
  return { ...summarize(detail, type), country_count: countries.length, countries };
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
      with_watch_providers: DISNEY_FILTER,
      with_watch_monetization_types: "flatrate",
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

/** Countries where TMDB lists Disney+, from the providers' display_priorities maps. */
export async function listCountries() {
  const data = await get<{ results: { provider_id: number; display_priorities?: Record<string, number> }[] }>(
    "/watch/providers/movie",
  );
  const codes = new Set(
    data.results.filter((p) => DISNEY_IDS.includes(p.provider_id)).flatMap((p) => Object.keys(p.display_priorities ?? {})),
  );
  const list = [...codes].sort().map((code) => ({ code, country: countryName(code) }));
  return { count: list.length, countries: list };
}
