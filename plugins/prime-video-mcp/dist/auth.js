import{createRequire}from'module';const require=createRequire(import.meta.url);

// src/auth.ts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

// src/config.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
var override = process.env.PRIME_VIDEO_MCP_DIR;
var CONFIG_DIR = override ? override.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".config", "prime-video-mcp");
var API_KEY_PATH = join(CONFIG_DIR, "tmdb_key");
var AUTH_HINT = `node ${fileURLToPath(new URL("./auth.js", import.meta.url))}`;

// src/tmdb.ts
import { readFileSync } from "node:fs";

// ../../shared/tmdb/index.ts
var TMDB_BASE = "https://api.themoviedb.org/3";
var MAX_OVERVIEW_CHARS = 200;
var TIMEOUT_MS = 15e3;
var regionNames = new Intl.DisplayNames(["en"], { type: "region" });
var countryName = (code) => regionNames.of(code) ?? code;
function hasProvider(list, ids) {
  return (list ?? []).some((p) => ids.includes(p.provider_id));
}
function summarize(t, type) {
  const date = type === "movie" ? t.release_date : t.first_air_date;
  const overview = (t.overview ?? "").trim();
  return {
    tmdb_id: t.id,
    media_type: type,
    title: (type === "movie" ? t.title : t.name) ?? "",
    year: date ? date.slice(0, 4) : null,
    rating: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    overview: overview.length > MAX_OVERVIEW_CHARS ? overview.slice(0, MAX_OVERVIEW_CHARS) + "\u2026" : overview
  };
}
function authorize(url, cred) {
  const headers = { accept: "application/json" };
  if (cred.startsWith("eyJ")) headers.authorization = `Bearer ${cred}`;
  else url.searchParams.set("api_key", cred);
  return headers;
}
function createTmdb(deps, spec) {
  function credential() {
    const cred = deps.readCredential();
    if (cred) return cred;
    throw new Error(
      `No TMDB credential. Run the ${deps.setupSkill} skill, or ask the user to run: ${deps.authHint} (saves the key to ${deps.apiKeyPath}).`
    );
  }
  async function verifyCredential2(cred) {
    const url = new URL(`${TMDB_BASE}/authentication`);
    const res = await deps.fetch(url, { headers: authorize(url, cred), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401) return false;
    if (!res.ok) throw new Error(`TMDB check failed (${res.status}); try again later.`);
    return true;
  }
  async function get(path, params = {}) {
    const cred = credential();
    const url = new URL(TMDB_BASE + path);
    const headers = authorize(url, cred);
    for (const [k, v] of Object.entries(params)) if (v !== void 0 && v !== "") url.searchParams.set(k, String(v));
    const res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401) {
      throw new Error(`TMDB rejected the credential in ${deps.apiKeyPath} (401). Run the ${deps.setupSkill} skill to replace it.`);
    }
    if (!res.ok) throw new Error(`TMDB request failed (${res.status}) for ${path}`);
    return await res.json();
  }
  async function offeredCountries(type, id) {
    const data = await get(`/${type}/${id}/watch/providers`);
    const out = {};
    for (const [code, region] of Object.entries(data.results ?? {})) {
      const availability = spec.classify(region);
      if (availability) out[code] = availability;
    }
    return out;
  }
  async function searchTitles2(query, type, country, max) {
    const data = await get(type === "all" ? "/search/multi" : `/search/${type}`, {
      query,
      include_adult: false
    });
    const hits = data.results.map((t) => ({ t, type: type === "all" ? t.media_type : type })).filter((h) => h.type === "movie" || h.type === "tv").slice(0, max);
    const availability = await Promise.all(hits.map((h) => offeredCountries(h.type, h.t.id)));
    const results = [];
    hits.forEach((h, i) => {
      const countries = availability[i];
      const base = summarize(h.t, h.type);
      if (!country) return void results.push({ ...base, ...spec.worldFields(countries) });
      const here = countries[country];
      if (here) results.push({ ...base, ...spec.titleFields(here) });
    });
    return results;
  }
  async function checkAvailability2(type, id) {
    const [detail, countries] = await Promise.all([get(`/${type}/${id}`), offeredCountries(type, id)]);
    const list = Object.entries(countries).map(([code, availability]) => ({ code, country: countryName(code), ...availability })).sort((a, b) => a.country.localeCompare(b.country));
    return { ...summarize(detail, type), country_count: list.length, countries: list };
  }
  const genreCache = /* @__PURE__ */ new Map();
  async function genreId(type, name) {
    let genres = genreCache.get(type);
    if (!genres) {
      const data = await get(`/genre/${type}/list`, { language: "en-US" });
      genres = new Map(data.genres.map((g) => [g.name.toLowerCase(), g.id]));
      genreCache.set(type, genres);
    }
    const id = genres.get(name.trim().toLowerCase());
    if (id === void 0) throw new Error(`Unknown ${type} genre "${name}". Valid: ${[...genres.keys()].join(", ")}.`);
    return id;
  }
  async function browseCountry2(o) {
    const data = await get(
      `/discover/${o.type}`,
      {
        watch_region: o.country,
        with_watch_providers: spec.discoverProviders.join("|"),
        with_watch_monetization_types: spec.discoverMonetization,
        with_genres: o.genre ? await genreId(o.type, o.genre) : void 0,
        with_origin_country: o.originCountry || void 0,
        [o.type === "movie" ? "primary_release_year" : "first_air_date_year"]: o.year,
        sort_by: o.sortBy,
        page: o.page,
        include_adult: false,
        language: "en-US"
      }
    );
    return {
      country: o.country,
      page: data.page,
      total_pages: Math.min(data.total_pages, 500),
      // TMDB serves at most 500 pages
      total_results: data.total_results,
      results: data.results.map((t) => summarize(t, o.type))
    };
  }
  async function providerCountryCodes(...idGroups) {
    const data = await get(
      "/watch/providers/movie"
    );
    return idGroups.map(
      (ids) => data.results.filter((p) => ids.includes(p.provider_id)).flatMap((p) => Object.keys(p.display_priorities ?? {}))
    );
  }
  return { verifyCredential: verifyCredential2, searchTitles: searchTitles2, checkAvailability: checkAvailability2, browseCountry: browseCountry2, providerCountryCodes };
}

// src/tmdb.ts
var PRIME_IDS = [119, 9];
var PRIME_WITH_ADS = 2100;
var FREE_WITH_ADS = 613;
var AMAZON_VIDEO = 10;
function readCredential() {
  const env = process.env.TMDB_API_KEY?.trim();
  if (env) return env;
  try {
    return readFileSync(API_KEY_PATH, "utf8").trim() || void 0;
  } catch {
    return void 0;
  }
}
var included = (a) => a.prime || a.prime_with_ads;
var tmdb = createTmdb(
  { fetch: (input, init) => fetch(input, init), readCredential, apiKeyPath: API_KEY_PATH, authHint: AUTH_HINT, setupSkill: "prime-video-setup" },
  {
    // Browse covers what a subscription includes; free and rent-or-buy are reported per title only.
    discoverProviders: [...PRIME_IDS, PRIME_WITH_ADS],
    discoverMonetization: "flatrate",
    classify: (region) => {
      const access = {
        prime: hasProvider(region.flatrate, PRIME_IDS),
        prime_with_ads: hasProvider(region.flatrate, [PRIME_WITH_ADS]),
        free_with_ads: hasProvider(region.ads, [FREE_WITH_ADS]) || hasProvider(region.free, [FREE_WITH_ADS]),
        rent_or_buy: hasProvider(region.rent, [AMAZON_VIDEO]) || hasProvider(region.buy, [AMAZON_VIDEO])
      };
      return Object.values(access).some(Boolean) ? access : void 0;
    },
    titleFields: (access) => ({ ...access }),
    worldFields: (countries) => {
      const codes = Object.keys(countries).filter((c) => included(countries[c])).sort();
      return { prime_country_count: codes.length, prime_countries: codes.join(",") };
    }
  }
);
var { verifyCredential, searchTitles, checkAvailability, browseCountry } = tmdb;

// src/auth.ts
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => data += c);
      stdin.on("end", () => resolve(data.trim()));
      stdin.on("error", reject);
      return;
    }
    process.stdout.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        } else if (ch === "\x7F") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}
async function main() {
  console.log("Get a free key at https://www.themoviedb.org/settings/api (API Read Access Token or API Key).");
  const key = await readSecret("Paste your TMDB key (input hidden): ");
  if (!key) throw new Error("No key entered.");
  if (!await verifyCredential(key)) throw new Error("TMDB rejected that key. Check you copied the whole value.");
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
  writeFileSync(API_KEY_PATH, key, { mode: 384 });
  chmodSync(API_KEY_PATH, 384);
  console.log(`Key verified and saved to ${API_KEY_PATH}`);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
