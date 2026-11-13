/**
 * tmdb: the TMDB watch-provider client shared by the streaming-availability plugins
 * (netflix-mcp, disney-mcp, prime-video-mcp).
 *
 * Plugins do NOT depend on this at runtime: they import it by relative path and esbuild inlines
 * it into their own `dist/`, so every plugin stays independently installable. Keep this file
 * pure (no imports, no I/O, no logging) so it is safe in the MCP server path. Everything that
 * touches the outside world (fetch, the key file, env vars) is injected through `TmdbDeps`.
 *
 * What differs per service is only how a TMDB watch-provider region maps to "this service offers
 * the title": that is the `ProviderSpec` a plugin passes in.
 */

export type MediaType = "movie" | "tv";

export const TMDB_BASE = "https://api.themoviedb.org/3";
const MAX_OVERVIEW_CHARS = 200;
const TIMEOUT_MS = 15_000;

export interface Provider {
  provider_id: number;
}
/** One country's entry in TMDB's `watch/providers` response, keyed by how the title is offered. */
export interface Region {
  flatrate?: Provider[];
  ads?: Provider[];
  free?: Provider[];
  rent?: Provider[];
  buy?: Provider[];
}

/** Side effects a plugin supplies; the module itself never performs any. */
export interface TmdbDeps {
  fetch: typeof fetch;
  /** The TMDB key or token: env var first, then the key file. Undefined when neither is set. */
  readCredential: () => string | undefined;
  /** Shown in errors so the user knows where the key lives. */
  apiKeyPath: string;
  /** Command the user can run to save a key, shown in the "no credential" error. */
  authHint: string;
  /** Skill that walks the user through setup, e.g. "netflix-setup". */
  setupSkill: string;
}

/**
 * How one streaming service maps onto TMDB. `A` is the per-country availability record
 * (Netflix: standard/ads tiers; Disney+: an empty marker; Prime Video: four access types).
 */
export interface ProviderSpec<A extends object> {
  /** TMDB provider ids that count as "on this service" for browse (joined with "|", TMDB's OR). */
  discoverProviders: number[];
  /** TMDB `with_watch_monetization_types` for browse, e.g. "flatrate" or "flatrate|ads". */
  discoverMonetization: string;
  /** The service's availability in one country, or undefined when it does not offer the title there. */
  classify: (region: Region) => A | undefined;
  /** Extra fields on a search hit when a country was given (the title is offered there). */
  titleFields: (availability: A) => Record<string, unknown>;
  /** Extra fields on a search hit when no country was given, from every country that offers it. */
  worldFields: (countries: Record<string, A>) => Record<string, unknown>;
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

export function normalizeCountry(code: string): string {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw new Error(`Invalid country "${code}": use an ISO 3166-1 alpha-2 code such as US, JP, GB.`);
  return c;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
export const countryName = (code: string): string => regionNames.of(code) ?? code;

/** True if any entry in `list` is one of the provider `ids`. Handy inside `classify`. */
export function hasProvider(list: Provider[] | undefined, ids: number[]): boolean {
  return (list ?? []).some((p) => ids.includes(p.provider_id));
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

// v4 read access tokens are JWTs sent as a bearer header; v3 keys are 32 hex chars passed as a query param.
function authorize(url: URL, cred: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (cred.startsWith("eyJ")) headers.authorization = `Bearer ${cred}`;
  else url.searchParams.set("api_key", cred);
  return headers;
}

export function createTmdb<A extends object>(deps: TmdbDeps, spec: ProviderSpec<A>) {
  function credential(): string {
    const cred = deps.readCredential();
    if (cred) return cred;
    throw new Error(
      `No TMDB credential. Run the ${deps.setupSkill} skill, or ask the user to run: ${deps.authHint} (saves the key to ${deps.apiKeyPath}).`,
    );
  }

  /** True if TMDB accepts the credential; used by auth.ts before saving it. */
  async function verifyCredential(cred: string): Promise<boolean> {
    const url = new URL(`${TMDB_BASE}/authentication`);
    const res = await deps.fetch(url, { headers: authorize(url, cred), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401) return false;
    if (!res.ok) throw new Error(`TMDB check failed (${res.status}); try again later.`);
    return true;
  }

  async function get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const cred = credential();
    const url = new URL(TMDB_BASE + path);
    const headers = authorize(url, cred);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    // Errors name only the path: the URL may carry the api_key.
    if (res.status === 401) {
      throw new Error(`TMDB rejected the credential in ${deps.apiKeyPath} (401). Run the ${deps.setupSkill} skill to replace it.`);
    }
    if (!res.ok) throw new Error(`TMDB request failed (${res.status}) for ${path}`);
    return (await res.json()) as T;
  }

  /** Country code -> availability, for every country where the service offers the title. */
  async function offeredCountries(type: MediaType, id: number): Promise<Record<string, A>> {
    const data = await get<{ results?: Record<string, Region> }>(`/${type}/${id}/watch/providers`);
    const out: Record<string, A> = {};
    for (const [code, region] of Object.entries(data.results ?? {})) {
      const availability = spec.classify(region);
      if (availability) out[code] = availability;
    }
    return out;
  }

  async function searchTitles(query: string, type: MediaType | "all", country: string, max: number) {
    const data = await get<{ results: RawTitle[] }>(type === "all" ? "/search/multi" : `/search/${type}`, {
      query,
      include_adult: false,
    });
    const hits = data.results
      .map((t) => ({ t, type: (type === "all" ? t.media_type : type) as string }))
      .filter((h): h is { t: RawTitle; type: MediaType } => h.type === "movie" || h.type === "tv")
      .slice(0, max);
    const availability = await Promise.all(hits.map((h) => offeredCountries(h.type, h.t.id)));
    const results: Record<string, unknown>[] = [];
    hits.forEach((h, i) => {
      const countries = availability[i]!;
      const base = summarize(h.t, h.type);
      if (!country) return void results.push({ ...base, ...spec.worldFields(countries) });
      // With a country, keep only titles the service offers there.
      const here = countries[country];
      if (here) results.push({ ...base, ...spec.titleFields(here) });
    });
    return results;
  }

  async function checkAvailability(type: MediaType, id: number) {
    const [detail, countries] = await Promise.all([get<RawTitle>(`/${type}/${id}`), offeredCountries(type, id)]);
    const list = Object.entries(countries)
      .map(([code, availability]) => ({ code, country: countryName(code), ...availability }))
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

  async function browseCountry(o: BrowseOptions) {
    const data = await get<{ page: number; total_pages: number; total_results: number; results: RawTitle[] }>(
      `/discover/${o.type}`,
      {
        watch_region: o.country,
        with_watch_providers: spec.discoverProviders.join("|"),
        with_watch_monetization_types: spec.discoverMonetization,
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

  /**
   * Country codes where TMDB lists each group of provider ids, from the providers' display_priorities
   * maps. One request serves every group; the result has one array per group, in the same order.
   */
  async function providerCountryCodes(...idGroups: number[][]): Promise<string[][]> {
    const data = await get<{ results: { provider_id: number; display_priorities?: Record<string, number> }[] }>(
      "/watch/providers/movie",
    );
    return idGroups.map((ids) =>
      data.results.filter((p) => ids.includes(p.provider_id)).flatMap((p) => Object.keys(p.display_priorities ?? {})),
    );
  }

  return { verifyCredential, searchTitles, checkAvailability, browseCountry, providerCountryCodes };
}
