import { readFileSync } from "node:fs";
import { countryName, createTmdb, hasProvider } from "../../../shared/tmdb/index.js";
import { API_KEY_PATH, AUTH_HINT } from "./config.js";

export { normalizeCountry, type BrowseOptions, type MediaType } from "../../../shared/tmdb/index.js";

// TMDB provider ids: 337 = Disney Plus, 122 = Disney+ (legacy Hotstar-branded entry in GB, ID, IN, MY, TH).
// JioHotstar (2336, India) is a different service and is deliberately excluded. TMDB has no separate
// provider for the ad-supported tier, so this plugin cannot report it.
const DISNEY_IDS = [337, 122];

function readCredential(): string | undefined {
  const env = process.env.TMDB_API_KEY?.trim();
  if (env) return env;
  try {
    return readFileSync(API_KEY_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

// Disney+ has no tiers to report, so the per-country record is an empty marker: present means offered.
const tmdb = createTmdb<Record<never, never>>(
  { fetch: (input, init) => fetch(input, init), readCredential, apiKeyPath: API_KEY_PATH, authHint: AUTH_HINT, setupSkill: "disney-setup" },
  {
    discoverProviders: DISNEY_IDS,
    discoverMonetization: "flatrate",
    classify: (region) => (hasProvider(region.flatrate, DISNEY_IDS) ? {} : undefined),
    titleFields: () => ({ on_disney_plus: true }),
    worldFields: (countries) => {
      const codes = Object.keys(countries).sort();
      return { disney_country_count: codes.length, disney_countries: codes.join(",") };
    },
  },
);

export const { verifyCredential, searchTitles, checkAvailability, browseCountry } = tmdb;

/** Countries where TMDB lists Disney+, from the providers' display_priorities maps. */
export async function listCountries() {
  const [codes] = await tmdb.providerCountryCodes(DISNEY_IDS);
  const list = [...new Set(codes)].sort().map((code) => ({ code, country: countryName(code) }));
  return { count: list.length, countries: list };
}
