import { buildRawMessage, cleanSnippet, formatMessage, type DraftInput, type Message } from "./format.js";
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
  if (!res.ok) throw new Error(`Gmail API ${res.status} ${path}: ${await res.text()}`);
  return (await res.json()) as T;
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
