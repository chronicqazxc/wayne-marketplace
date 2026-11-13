import { readFileSync } from "node:fs";
import { countryName, createTmdb, hasProvider } from "../../../shared/tmdb/index.js";
import { API_KEY_PATH, AUTH_HINT } from "./config.js";

export { normalizeCountry, type BrowseOptions, type MediaType } from "../../../shared/tmdb/index.js";

// TMDB provider ids: 8 = Netflix, 1796 = Netflix Standard with Ads.
const NETFLIX_STANDARD = 8;
const NETFLIX_ADS = 1796;

interface Tiers {
  standard: boolean;
  ads: boolean;
}

function readCredential(): string | undefined {
  const env = process.env.TMDB_API_KEY?.trim();
  if (env) return env;
  try {
    return readFileSync(API_KEY_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const tmdb = createTmdb<Tiers>(
  { fetch: (input, init) => fetch(input, init), readCredential, apiKeyPath: API_KEY_PATH, authHint: AUTH_HINT, setupSkill: "netflix-setup" },
  {
    discoverProviders: [NETFLIX_STANDARD, NETFLIX_ADS],
    discoverMonetization: "flatrate|ads",
    classify: (region) => {
      const offered = [...(region.flatrate ?? []), ...(region.ads ?? [])];
      const tiers = { standard: hasProvider(offered, [NETFLIX_STANDARD]), ads: hasProvider(offered, [NETFLIX_ADS]) };
      return tiers.standard || tiers.ads ? tiers : undefined;
    },
    titleFields: (tiers) => ({ netflix_standard: tiers.standard, netflix_ads: tiers.ads }),
    worldFields: (countries) => {
      const codes = Object.keys(countries).sort();
      return {
        netflix_country_count: codes.length,
        netflix_countries: codes.join(","),
        netflix_ads_countries: codes.filter((c) => countries[c]!.ads).join(","),
      };
    },
  },
);

export const { verifyCredential, searchTitles, checkAvailability, browseCountry } = tmdb;

/** Countries where TMDB lists Netflix, from each provider's display_priorities map; ad_plan marks those with the ad tier. */
export async function listCountries(adPlanOnly: boolean) {
  const [standardCodes, adCodes] = await tmdb.providerCountryCodes([NETFLIX_STANDARD], [NETFLIX_ADS]);
  const withAds = new Set(adCodes);
  const list = [...new Set([...standardCodes, ...withAds])]
    .sort()
    .map((code) => ({ code, country: countryName(code), ad_plan: withAds.has(code) }))
    .filter((c) => !adPlanOnly || c.ad_plan);
  return { count: list.length, countries: list };
}
