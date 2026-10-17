import { API_VERSION } from "./config.js";
import { loadToken } from "./token-store.js";

const BASE = "https://api.linkedin.com";

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const { accessToken } = await loadToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "LinkedIn-Version": API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`LinkedIn API ${res.status} ${path}: ${await res.text()}`);
  }
  return res;
}

export async function getUserInfo(): Promise<Record<string, unknown>> {
  return (await call("/v2/userinfo")).json();
}

export interface CreatePostInput {
  text: string;
  visibility: "PUBLIC" | "CONNECTIONS";
  article?: { url: string; title?: string; description?: string };
}

/** Returns the new post URN (from the x-restli-id header). */
export async function createPost(input: CreatePostInput): Promise<string> {
  const { sub } = await loadToken();
  const body = {
    author: `urn:li:person:${sub}`,
    commentary: input.text,
    visibility: input.visibility,
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
    ...(input.article && {
      content: {
        article: {
          source: input.article.url,
          title: input.article.title ?? input.article.url,
          description: input.article.description,
        },
      },
    }),
  };
  const res = await call("/rest/posts", { method: "POST", body: JSON.stringify(body) });
  return res.headers.get("x-restli-id") ?? "(unknown urn)";
}

/** Replaces a post's commentary. Only commentary/CTA fields are editable; media and visibility are not. */
export async function editPost(urn: string, text: string): Promise<void> {
  await call(`/rest/posts/${encodeURIComponent(urn)}`, {
    method: "POST",
    headers: { "X-RestLi-Method": "PARTIAL_UPDATE" },
    body: JSON.stringify({ patch: { $set: { commentary: text } } }),
  });
}

export async function deletePost(urn: string): Promise<void> {
  await call(`/rest/posts/${encodeURIComponent(urn)}`, {
    method: "DELETE",
    headers: { "X-RestLi-Method": "DELETE" },
  });
}
