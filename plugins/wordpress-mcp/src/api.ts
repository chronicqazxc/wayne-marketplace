import { readFile } from "node:fs/promises";
import { API_BASE, getSite, getToken } from "./config.js";

export type Status = "draft" | "publish" | "private" | "pending" | "future";

export interface PostFields {
  title?: string;
  content?: string;
  status?: Status;
  categories?: string[];
  tags?: string[];
}

export class WpError extends Error {}

async function request(method: "GET" | "POST", path: string, form?: URLSearchParams, query?: URLSearchParams) {
  const url = `${API_BASE}/sites/${encodeURIComponent(getSite())}/${path}${query?.size ? `?${query}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form,
  });
  const raw = await res.text();
  let body: any;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }
  if (!res.ok) {
    const msg = body?.message ?? body?.error_description ?? body?.error ?? raw.slice(0, 500);
    throw new WpError(`HTTP ${res.status} ${res.statusText}: ${msg}${body?.error ? ` (${body.error})` : ""}`);
  }
  return body;
}

export async function readContentFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function toForm(f: PostFields): URLSearchParams {
  const p = new URLSearchParams();
  if (f.title !== undefined) p.set("title", f.title);
  if (f.content !== undefined) p.set("content", f.content);
  if (f.status !== undefined) p.set("status", f.status);
  if (f.categories) p.set("categories", f.categories.join(","));
  if (f.tags) p.set("tags", f.tags.join(","));
  return p;
}

export const createPost = (f: PostFields) => request("POST", "posts/new", toForm(f));
export const updatePost = (id: number, f: PostFields) => request("POST", `posts/${id}`, toForm(f));
// raw=true asks for the stored HTML (context=edit) instead of the filtered display version.
export const getPost = (id: number, raw = false) =>
  request("GET", `posts/${id}`, undefined, raw ? new URLSearchParams({ context: "edit" }) : undefined);
export const deletePost = (id: number) => request("POST", `posts/${id}/delete`, new URLSearchParams());
export const listPosts = (status: string | undefined, number: number) =>
  request("GET", "posts", undefined, new URLSearchParams({ number: String(number), ...(status ? { status } : {}) }));
export const getMe = async () => {
  const res = await fetch(`${API_BASE.replace(/\/rest\/v1\.1$/, "")}/rest/v1.1/me`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  const raw = await res.text();
  if (!res.ok) throw new WpError(`HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 500)}`);
  return JSON.parse(raw);
};

// Compact view for callers: always ID, status, URL.
export function summarize(p: any, withContent = false) {
  return {
    ID: p.ID,
    status: p.status,
    URL: p.URL,
    title: p.title,
    modified: p.modified,
    ...(withContent ? { content: p.content } : {}),
  };
}
