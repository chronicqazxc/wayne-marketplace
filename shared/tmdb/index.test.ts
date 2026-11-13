import assert from "node:assert/strict";
import { test } from "node:test";
import { createTmdb, hasProvider, normalizeCountry, type ProviderSpec, type Region } from "./index.ts";

interface Offer {
  tier: string;
}
const spec: ProviderSpec<Offer> = {
  discoverProviders: [1, 2],
  discoverMonetization: "flatrate",
  classify: (r: Region) => (hasProvider(r.flatrate, [1, 2]) ? { tier: "sub" } : undefined),
  titleFields: (o) => ({ tier: o.tier }),
  worldFields: (cs) => ({ countries: Object.keys(cs).sort().join(",") }),
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fake TMDB: routes on pathname and records every URL it was asked for. */
function setup(routes: Record<string, unknown>, opts: { key?: string | undefined; status?: number } = {}) {
  const calls: URL[] = [];
  const fake = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url);
    if (opts.status) return json({}, opts.status);
    const body = routes[url.pathname.replace(/^\/3/, "")];
    return body === undefined ? json({}, 404) : json(body);
  }) as typeof fetch;
  const tmdb = createTmdb(
    {
      fetch: fake,
      readCredential: () => ("key" in opts ? opts.key : "k"),
      apiKeyPath: "/cfg/tmdb_key",
      authHint: "node auth.js",
      setupSkill: "demo-setup",
    },
    spec,
  );
  return { tmdb, calls };
}

const providers = { results: { US: { flatrate: [{ provider_id: 1 }] }, JP: { flatrate: [{ provider_id: 99 }] } } };
const search = { results: [{ id: 7, media_type: "movie", title: "T" }, { id: 8, media_type: "person", name: "P" }] };

test("normalizeCountry uppercases and rejects non-alpha-2", () => {
  assert.equal(normalizeCountry(" jp "), "JP");
  assert.throws(() => normalizeCountry("usa"), /Invalid country/);
});

test("search without a country reports every offering country; people are skipped", async () => {
  const { tmdb } = setup({ "/search/multi": search, "/movie/7/watch/providers": providers });
  const out = await tmdb.searchTitles("t", "all", "", 10);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.countries, "US");
});

test("search with a country keeps only titles offered there", async () => {
  const { tmdb } = setup({ "/search/multi": search, "/movie/7/watch/providers": providers });
  assert.equal((await tmdb.searchTitles("t", "all", "US", 10)).length, 1);
  assert.equal((await tmdb.searchTitles("t", "all", "JP", 10)).length, 0);
});

test("checkAvailability lists countries sorted by name with the availability spread in", async () => {
  const routes = {
    "/movie/7": { id: 7, title: "T" },
    "/movie/7/watch/providers": { results: { US: { flatrate: [{ provider_id: 2 }] }, AU: { flatrate: [{ provider_id: 1 }] } } },
  };
  const out = await setup(routes).tmdb.checkAvailability("movie", 7);
  assert.deepEqual(out.countries.map((c) => c.code), ["AU", "US"]);
  assert.equal(out.countries[0]!.tier, "sub");
});

test("browse sends the spec's providers and monetization, and caps pages at 500", async () => {
  const routes = { "/discover/tv": { page: 1, total_pages: 900, total_results: 5, results: [] } };
  const { tmdb, calls } = setup(routes);
  const out = await tmdb.browseCountry({ country: "US", type: "tv", genre: "", originCountry: "", year: 2020, sortBy: "popularity.desc", page: 1 });
  assert.equal(out.total_pages, 500);
  const q = calls[0]!.searchParams;
  assert.equal(q.get("with_watch_providers"), "1|2");
  assert.equal(q.get("with_watch_monetization_types"), "flatrate");
  assert.equal(q.get("first_air_date_year"), "2020");
  assert.equal(q.get("with_genres"), null);
});

test("unknown genre error lists the valid names", async () => {
  const { tmdb } = setup({ "/genre/movie/list": { genres: [{ id: 35, name: "Comedy" }] } });
  const o = { country: "US", type: "movie" as const, genre: "nope", originCountry: "", year: undefined, sortBy: "x", page: 1 };
  await assert.rejects(tmdb.browseCountry(o), /Unknown movie genre "nope". Valid: comedy\./);
});

test("providerCountryCodes answers every group from one request", async () => {
  const routes = {
    "/watch/providers/movie": { results: [{ provider_id: 1, display_priorities: { US: 0, JP: 1 } }, { provider_id: 3, display_priorities: { FR: 0 } }] },
  };
  const { tmdb, calls } = setup(routes);
  assert.deepEqual(await tmdb.providerCountryCodes([1], [3], [9]), [["US", "JP"], ["FR"], []]);
  assert.equal(calls.length, 1);
});

test("credentials: v3 key goes in the query, v4 token in the header, neither leaks into errors", async () => {
  const v3 = setup({ "/authentication": {} }, { key: "abc" });
  await v3.tmdb.verifyCredential("abc");
  assert.equal(v3.calls[0]!.searchParams.get("api_key"), "abc");

  const missing = setup({}, { key: undefined });
  await assert.rejects(missing.tmdb.searchTitles("q", "all", "", 1), /No TMDB credential\. Run the demo-setup skill.*node auth\.js.*\/cfg\/tmdb_key/);

  const rejected = setup({}, { key: "secret-key", status: 401 });
  await assert.rejects(rejected.tmdb.searchTitles("q", "all", "", 1), (e: Error) => /401/.test(e.message) && !e.message.includes("secret-key"));
});

test("verifyCredential: 401 is false, other failures throw", async () => {
  assert.equal(await setup({}, { status: 401 }).tmdb.verifyCredential("x"), false);
  await assert.rejects(setup({}, { status: 500 }).tmdb.verifyCredential("x"), /try again later/);
});
