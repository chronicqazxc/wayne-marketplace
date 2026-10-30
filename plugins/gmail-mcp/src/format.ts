export const MAX_BODY_CHARS = 20_000;

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  headers?: Header[];
  body?: { data?: string };
  parts?: Part[];
}
export interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload?: Part;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•",
  middot: "·", euro: "€",
};

function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
    const cp = ref[1].toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
  });
}

// Cap by code points (not UTF-16 units) so an emoji is never split or counted twice.
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return Array.from(s.slice(0, max * 2)).slice(0, max).join("");
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** Prefer text/plain; fall back to tag-stripped text/html. */
export function extractBody(payload: Part): string {
  const plain: string[] = [];
  const rich: string[] = [];
  const walk = (part: Part): void => {
    const data = part.body?.data;
    if (data && part.mimeType === "text/plain") plain.push(decode(data));
    else if (data && part.mimeType === "text/html") rich.push(decode(data));
    part.parts?.forEach(walk);
  };
  walk(payload);

  let text: string;
  if (plain.length) {
    text = plain.join("\n");
  } else {
    text = rich.join("\n").replace(/<(script|style).*?<\/\1>/gis, "");
    text = unescapeHtml(text.replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ");
  }
  return truncate(text, MAX_BODY_CHARS);
}

const header = (headers: Header[], name: string): string =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

export function formatMessage(msg: Message) {
  const headers = msg.payload?.headers ?? [];
  return {
    id: msg.id,
    thread_id: msg.threadId,
    from: header(headers, "From"),
    to: header(headers, "To"),
    cc: header(headers, "Cc"),
    subject: header(headers, "Subject"),
    date: header(headers, "Date"),
    labels: msg.labelIds ?? [],
    body: extractBody(msg.payload ?? {}),
  };
}

function assertSingleLine(name: string, value: string): string {
  // A CR/LF would let injected text add headers (e.g. a hidden Bcc).
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain line breaks`);
  return value;
}

// RFC 2047 encoded-words (max 75 chars each), split on code points so no character is cut.
function encodeSubject(subject: string): string {
  if (!/[^\x20-\x7e]/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = "";
  for (const ch of subject) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

/** Builds an RFC 2822 message and returns it base64url-encoded, as the Gmail API's `raw` field expects. */
export function buildRawMessage(input: DraftInput): string {
  const lines = [`To: ${assertSingleLine("to", input.to)}`];
  if (input.cc) lines.push(`Cc: ${assertSingleLine("cc", input.cc)}`);
  if (input.bcc) lines.push(`Bcc: ${assertSingleLine("bcc", input.bcc)}`);
  lines.push(
    `Subject: ${encodeSubject(assertSingleLine("subject", input.subject))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    (Buffer.from(input.body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
  );
  return Buffer.from(lines.join("\r\n") + "\r\n").toString("base64url");
}
