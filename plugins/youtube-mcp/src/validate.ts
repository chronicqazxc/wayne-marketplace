// Pure input checks (no imports, no I/O). YouTube rejects these server-side with vague errors,
// so fail early with a clear message.

export function checkTitle(title: string): string {
  const t = title.trim();
  if (!t) throw new Error("title must not be empty");
  if ([...t].length > 100) throw new Error("title is over 100 characters");
  if (/[<>]/.test(t)) throw new Error("title must not contain < or >");
  return t;
}

export function checkDescription(d: string): string {
  if (new TextEncoder().encode(d).length > 5000) throw new Error("description is over 5000 bytes");
  if (/[<>]/.test(d)) throw new Error("description must not contain < or >");
  return d;
}

/** Tags: total length of all tags is capped at 500 characters (quoted tags with spaces count +2). */
export function checkTags(tags: string[]): string[] {
  const clean = tags.map((t) => t.trim()).filter(Boolean);
  if (clean.some((t) => /[<>]/.test(t))) throw new Error("tags must not contain < or >");
  const total = clean.reduce((n, t) => n + [...t].length + (t.includes(" ") ? 2 : 0), 0) + Math.max(0, clean.length - 1);
  if (total > 500) throw new Error(`tags total ${total} characters; YouTube allows 500`);
  return clean;
}

/** publishAt must be a future ISO 8601 instant; returns it normalised to UTC. */
export function checkPublishAt(s: string, now = Date.now()): string {
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`publish_at is not a valid ISO 8601 date-time: ${s}`);
  if (ms <= now) throw new Error("publish_at must be in the future");
  return new Date(ms).toISOString();
}

export function checkDate(name: string, s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`${name} must be YYYY-MM-DD`);
  return s;
}

export function checkToken(name: string, s: string, re: RegExp): string {
  if (!re.test(s)) throw new Error(`${name} has unsupported characters`);
  return s;
}

export const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export function checkId(name: string, s: string): string {
  if (!ID_RE.test(s)) throw new Error(`${name} is not a valid YouTube id`);
  return s;
}

/** Last path segment of a YouTube URL or a bare id -> id. */
export function videoIdFrom(s: string): string {
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  return checkId("video id", m ? m[1] : s.trim());
}
