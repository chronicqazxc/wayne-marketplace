import { readFileSync } from "node:fs";
import { countryName, createTmdb, hasProvider } from "../../../shared/tmdb/index.js";
import { API_KEY_PATH, AUTH_HINT } from "./config.js";

export { normalizeCountry, type BrowseOptions, type MediaType } from "../../../shared/tmdb/index.js";

// TMDB provider ids. Amazon Channels (add-on subscriptions such as Paramount+) are other services and are excluded.
const PRIME_IDS = [119, 9]; // Amazon Prime Video (9 is the legacy id in AT, DE, GB, JP, US)
const PRIME_WITH_ADS = 2100; // Amazon Prime Video with Ads
const FREE_WITH_ADS = 613; // Amazon Prime Video Free with Ads (no subscription)
const AMAZON_VIDEO = 10; // Amazon Video: rent or buy

interface Access {
  prime: boolean;
  prime_with_ads: boolean;
  free_with_ads: boolean;
  rent_or_buy: boolean;
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

const included = (a: Access) => a.prime || a.prime_with_ads;

const tmdb = createTmdb<Access>(
  { fetch: (input, init) => fetch(input, init), readCredential, apiKeyPath: API_KEY_PATH, authHint: AUTH_HINT, setupSkill: "prime-video-setup" },
  {
    // Browse covers what a subscription includes; free and rent-or-buy are reported per title only.
    discoverProviders: [...PRIME_IDS, PRIME_WITH_ADS],
    discoverMonetization: "flatrate",
    classify: (region) => {
      const access: Access = {
        prime: hasProvider(region.flatrate, PRIME_IDS),
        prime_with_ads: hasProvider(region.flatrate, [PRIME_WITH_ADS]),
        free_with_ads: hasProvider(region.ads, [FREE_WITH_ADS]) || hasProvider(region.free, [FREE_WITH_ADS]),
        rent_or_buy: hasProvider(region.rent, [AMAZON_VIDEO]) || hasProvider(region.buy, [AMAZON_VIDEO]),
      };
      return Object.values(access).some(Boolean) ? access : undefined;
    },
    titleFields: (access) => ({ ...access }),
    worldFields: (countries) => {
      const codes = Object.keys(countries).filter((c) => included(countries[c]!)).sort();
      return { prime_country_count: codes.length, prime_countries: codes.join(",") };
    },
  },
);

export const { verifyCredential, searchTitles, checkAvailability, browseCountry } = tmdb;

/** Countries where TMDB lists Prime Video as a subscription, from the providers' display_priorities maps. */
export async function listCountries(adPlanOnly: boolean) {
  const [primeCodes, adCodes] = await tmdb.providerCountryCodes(PRIME_IDS, [PRIME_WITH_ADS]);
  const withAds = new Set(adCodes);
  const list = [...new Set([...primeCodes, ...withAds])]
    .sort()
    .map((code) => ({ code, country: countryName(code), prime_with_ads: withAds.has(code) }))
    .filter((c) => !adPlanOnly || c.prime_with_ads);
  return { count: list.length, countries: list };
}
