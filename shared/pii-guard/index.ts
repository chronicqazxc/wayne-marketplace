/**
 * pii-guard: best-effort masking of structured PII in text, shared by the marketplace plugins.
 *
 * Plugins do NOT depend on this at runtime: they import it by relative path and esbuild inlines
 * it into their own `dist/`, so every plugin stays independently installable. Keep this file
 * pure (no imports, no I/O, no logging) so it is safe in the MCP server path.
 *
 * It catches structured values only (cards, IDs, keys, codes). It does not find names, addresses
 * or medical details in free text, and it is not a compliance control.
 */

export type PiiKind = "SECRET" | "IBAN" | "CARD" | "SSN" | "TW_ID" | "OTP" | "PHONE" | "EMAIL";
/** off: do nothing. mask: high-precision detectors. strict: mask plus phone numbers and email addresses. */
export type PiiMode = "off" | "mask" | "strict";
export type PiiCounts = Partial<Record<PiiKind, number>>;

export interface RedactResult {
  text: string;
  counts: PiiCounts;
}

/**
 * Reads the mode from an env var. A missing value means "mask"; so does an unknown one, so a typo
 * can never silently turn the guard off.
 */
export function modeFromEnv(env: Record<string, string | undefined>, name: string): PiiMode {
  const v = env[name]?.trim().toLowerCase();
  return v === "off" || v === "strict" ? v : "mask";
}

// ---------- validators (they keep order numbers and the like from being masked) ----------

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

const TW_LETTER = "ABCDEFGHJKLMNPQRSTUVXYWZIO"; // index + 10 = the letter's code
function validTwId(id: string): boolean {
  const code = TW_LETTER.indexOf(id[0]) + 10;
  const digits = [Math.floor(code / 10), code % 10, ...id.slice(1).split("").map(Number)];
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  return digits.reduce((s, d, i) => s + d * weights[i], 0) % 10 === 0;
}

function validIban(iban: string): boolean {
  if (iban.length < 15 || iban.length > 34) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = Number(String(rem) + String(v)) % 97;
  }
  return rem === 1;
}

function validSsn(s: string): boolean {
  const [area, group, serial] = s.split("-");
  return area !== "000" && area !== "666" && area[0] !== "9" && group !== "00" && serial !== "0000";
}

// ---------- detectors ----------

interface Rule {
  kind: PiiKind;
  strictOnly?: boolean;
  pattern: RegExp;
  /** Return the replacement, or null to leave the match alone (failed validation). */
  replace: (match: string, ...groups: string[]) => string | null;
}

const tag = (kind: PiiKind) => `[REDACTED:${kind}]`;

// Order matters: specific, high-confidence rules run first. Placeholders hold no digits, so later
// rules cannot re-match them.
const RULES: Rule[] = [
  {
    kind: "SECRET",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: () => tag("SECRET"),
  },
  {
    kind: "SECRET",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,})/g,
    replace: () => tag("SECRET"),
  },
  {
    // "password is hunter2", "密碼：abc123": mask only the value, keep the label.
    kind: "SECRET",
    pattern: /((?:password|passcode|passwd|pwd|密碼)\s*(?:is|:|=|為|是|：)\s*)(\S+)/gi,
    replace: (_m, label) => label + tag("SECRET"),
  },
  {
    kind: "IBAN",
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{2,4}){3,8}\b/g,
    replace: (m) => {
      // Trailing uppercase words can be swallowed by the pattern: shrink until the checksum holds.
      const groups = m.split(" ");
      for (let n = groups.length; n >= 3; n--) {
        const candidate = groups.slice(0, n).join(" ");
        if (validIban(candidate.replace(/ /g, ""))) return tag("IBAN") + (n < groups.length ? " " + groups.slice(n).join(" ") : "");
      }
      return null;
    },
  },
  {
    kind: "CARD",
    pattern: /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g,
    replace: (m) => (luhn(m.replace(/\D/g, "")) ? tag("CARD") : null),
  },
  {
    kind: "SSN",
    pattern: /(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g,
    replace: (m) => (validSsn(m) ? tag("SSN") : null),
  },
  {
    kind: "TW_ID",
    pattern: /\b[A-Z][12]\d{8}\b/g,
    replace: (m) => (validTwId(m) ? tag("TW_ID") : null),
  },
  {
    // One-time codes: mask the digits that follow "code", "OTP", "驗證碼", ...
    kind: "OTP",
    pattern: /((?:verification|security|login|one[- ]time|auth(?:entication)?)?\s*(?:code|otp|pin|驗證碼|認證碼|驗證代碼)[^\d\n]{0,25}?)(\d(?:[ -]?\d){3,7})(?![\w])/gi,
    replace: (_m, label) => label + tag("OTP"),
  },
  {
    kind: "EMAIL",
    strictOnly: true,
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    replace: () => tag("EMAIL"),
  },
  {
    // +country-code numbers, parenthesised area codes, and Taiwan mobiles. Bare digit runs and
    // ISO dates are left alone to avoid masking ids and timestamps.
    kind: "PHONE",
    strictOnly: true,
    pattern: /(?<![\w.])(?:\+\d[\d\s().-]{7,17}\d|\(\d{2,4}\)[\s.-]?\d[\d\s.-]{5,12}\d|09\d{2}[ -]?\d{3}[ -]?\d{3})(?![\w])/g,
    replace: (m) => {
      const n = m.replace(/\D/g, "").length;
      return n >= 9 && n <= 15 ? tag("PHONE") : null;
    },
  },
];

export function redact(text: string, mode: PiiMode = "mask"): RedactResult {
  const counts: PiiCounts = {};
  if (mode === "off" || !text) return { text, counts };
  let out = text;
  for (const rule of RULES) {
    if (rule.strictOnly && mode !== "strict") continue;
    out = out.replace(rule.pattern, (...args) => {
      const groups = args.slice(0, -2).slice(1) as string[]; // drop offset + full string
      const replacement = rule.replace(args[0] as string, ...groups);
      if (replacement === null) return args[0] as string;
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      return replacement;
    });
  }
  return { text: out, counts };
}

/** Kinds of PII present, without the values: for refusing outbound content. Uses `mask` rules. */
export function detect(text: string): PiiKind[] {
  return Object.keys(redact(text, "mask").counts) as PiiKind[];
}

export interface RedactDeepOptions {
  mode: PiiMode;
  /** Object keys whose values pass through untouched (ids, headers the caller needs readable). */
  skipKeys?: readonly string[];
}

/**
 * Masks every string inside a JSON-like value. This is the single choke point a plugin can wrap
 * its tool results in, so a tool added later is covered without remembering to call redact().
 * Returns a copy; `counts` totals what was masked.
 */
export function redactDeep<T>(value: T, opts: RedactDeepOptions): { value: T; counts: PiiCounts } {
  const counts: PiiCounts = {};
  const skip = new Set(opts.skipKeys ?? []);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redact(v, opts.mode);
      for (const [k, n] of Object.entries(r.counts)) counts[k as PiiKind] = (counts[k as PiiKind] ?? 0) + n;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, skip.has(k) ? x : walk(x)]));
    }
    return v;
  };
  return { value: walk(value) as T, counts };
}
