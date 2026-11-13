import { buildRawMessage, cleanSnippet, formatMessage, type DraftInput, type Message } from "./format.js";
import { AUTH_HINT } from "./config.js";
import { getAccessToken } from "./token-store.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RESULTS_CAP = 50;

async function call<T>(path: string, params: Record<string, string | number> = {}, init: RequestInit = {}): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
  });
  const body = await res.text();
  if (!res.ok) {
    // A login from before the write tools existed only has read + compose access.
    if (res.status === 403 && /insufficient/i.test(body)) {
      throw new Error(`Insufficient permissions: the saved login lacks the gmail.modify scope. Run: ${AUTH_HINT}`);
    }
    throw new Error(`Gmail API ${res.status} ${path}: ${body}`);
  }
  return (body ? JSON.parse(body) : {}) as T; // e.g. label delete returns an empty 204
}

const enc = encodeURIComponent;

export async function searchThreads(query: string, maxResults: number) {
  const res = await call<{ threads?: { id: string; snippet?: string }[] }>("/threads", {
    q: query,
    maxResults: Math.min(maxResults, MAX_RESULTS_CAP),
  });
  return (res.threads ?? []).map((t) => ({ id: t.id, snippet: cleanSnippet(t.snippet ?? "") }));
}

export async function getThread(threadId: string) {
  const t = await call<{ id: string; messages: Message[] }>(`/threads/${enc(threadId)}`, { format: "full" });
  return { id: t.id, messages: t.messages.map(formatMessage) };
}

export async function getMessage(messageId: string) {
  return formatMessage(await call<Message>(`/messages/${enc(messageId)}`, { format: "full" }));
}

export async function listLabels() {
  const res = await call<{ labels?: { id: string; name: string; type: string }[] }>("/labels");
  return (res.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
}

/** Exact unread counts from the label's own counters (one call, regardless of mailbox size). */
export async function getUnreadCount(labelId: string) {
  const l = await call<{ id: string; name: string; threadsUnread?: number; messagesUnread?: number }>(
    `/labels/${enc(labelId)}`,
  );
  return { label: l.name, threads_unread: l.threadsUnread ?? 0, messages_unread: l.messagesUnread ?? 0 };
}

export async function listDrafts(maxResults: number) {
  const res = await call<{ drafts?: { id: string; message: { id: string } }[] }>("/drafts", {
    maxResults: Math.min(maxResults, MAX_RESULTS_CAP),
  });
  return (res.drafts ?? []).map((d) => ({ id: d.id, message_id: d.message.id }));
}

export async function createDraft(input: DraftInput & { threadId?: string }) {
  const message: { raw: string; threadId?: string } = { raw: buildRawMessage(input) };
  if (input.threadId) message.threadId = input.threadId;
  const draft = await call<{ id: string; message: { id: string } }>(
    "/drafts",
    {},
    { method: "POST", body: JSON.stringify({ message }) },
  );
  return { draft_id: draft.id, message_id: draft.message.id };
}

// ---------- mailbox changes ----------
// Deliberately limited: explicit ids only (never a search query), capped per call, trash instead of
// permanent delete. A prompt-injected email can therefore only touch a few items, recoverably.

export const MAX_IDS = 25;
export type Target = "thread" | "message";
/** Labels that change what a message *is*: reachable only through the dedicated tools. */
const PROTECTED_LABELS = new Set(["SPAM", "TRASH", "DRAFT", "SENT"]);

interface BatchResult {
  updated: number;
  failed: { id: string; error: string }[];
}

async function eachId(ids: string[], fn: (id: string) => Promise<unknown>): Promise<BatchResult> {
  if (ids.length > MAX_IDS) throw new Error(`At most ${MAX_IDS} ids per call (got ${ids.length})`);
  const unique = [...new Set(ids)];
  const results = await Promise.allSettled(unique.map(fn));
  const failed = results.flatMap((r, i) =>
    r.status === "rejected" ? [{ id: unique[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) }] : [],
  );
  return { updated: unique.length - failed.length, failed };
}

const post = (path: string, body?: unknown) =>
  call(path, {}, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export function modifyLabels(target: Target, ids: string[], add: string[], remove: string[]) {
  return eachId(ids, (id) =>
    post(`/${target}s/${enc(id)}/modify`, { addLabelIds: add, removeLabelIds: remove }),
  );
}

/** Same as modifyLabels but for caller-supplied labels: SPAM/TRASH/DRAFT/SENT are refused. */
export function modifyUserLabels(target: Target, ids: string[], add: string[], remove: string[]) {
  const blocked = [...add, ...remove].filter((l) => PROTECTED_LABELS.has(l.toUpperCase()));
  if (blocked.length) {
    throw new Error(`Label(s) ${blocked.join(", ")} cannot be changed here: use report_spam, not_spam, trash or untrash`);
  }
  return modifyLabels(target, ids, add, remove);
}

/** Moves to Trash (recoverable for 30 days) or back out. There is no permanent delete. */
export function setTrashed(target: Target, ids: string[], trashed: boolean) {
  return eachId(ids, (id) => post(`/${target}s/${enc(id)}/${trashed ? "trash" : "untrash"}`));
}

export async function createLabel(name: string) {
  const l = await post("/labels", {
    name,
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
  });
  const { id, name: n } = l as { id: string; name: string };
  return { id, name: n };
}

/** Removes the label from every message; the messages themselves are kept. */
export async function deleteLabel(labelId: string) {
  const l = await call<{ type?: string }>(`/labels/${enc(labelId)}`);
  if (l.type === "system") throw new Error("System labels cannot be deleted");
  await call(`/labels/${enc(labelId)}`, {}, { method: "DELETE" });
  return { deleted: labelId };
}
