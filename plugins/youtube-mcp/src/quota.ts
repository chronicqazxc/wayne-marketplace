import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { CONFIG_DIR, QUOTA_PATH } from "./config.js";

// The Data API quota is per Google Cloud project and resets at midnight Pacific. This is an ESTIMATE:
// it only counts calls made through this plugin on this machine, so other tools sharing the project
// are invisible. Persistence failures are swallowed on purpose: quota bookkeeping must never fail a call.
export const DAILY_LIMIT = Number(process.env.YOUTUBE_DAILY_QUOTA) > 0 ? Number(process.env.YOUTUBE_DAILY_QUOTA) : 10_000;
export const UPLOAD_COST = 1600;

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function pacificNow(now = Date.now()) {
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const sinceMidnight = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  return { date: `${p.year}-${p.month}-${p.day}`, hoursToReset: Math.round(((86400 - sinceMidnight) / 3600) * 10) / 10 };
}

interface QuotaFile { date: string; spent: number }

async function readFileState(today: string): Promise<QuotaFile> {
  try {
    const q = JSON.parse(await readFile(QUOTA_PATH, "utf8")) as Partial<QuotaFile>;
    if (q.date === today && typeof q.spent === "number" && q.spent >= 0) return { date: today, spent: q.spent };
  } catch {
    /* missing or corrupt: start the day at 0 */
  }
  return { date: today, spent: 0 };
}

async function writeState(q: QuotaFile): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${QUOTA_PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(q), { mode: 0o600 });
    await rename(tmp, QUOTA_PATH);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// Writes are chained so parallel tool calls never interleave their read-modify-write.
let chain: Promise<void> = Promise.resolve();

export function recordSpend(units: number): void {
  if (units <= 0) return;
  chain = chain
    .then(async () => {
      const q = await readFileState(pacificNow().date);
      q.spent += units;
      await writeState(q);
    })
    .catch(() => {});
}

export async function quotaStatus() {
  await chain;
  const { date, hoursToReset } = pacificNow();
  const { spent } = await readFileState(date);
  const remaining = Math.max(0, DAILY_LIMIT - spent);
  return {
    pacific_date: date,
    spent_units: spent,
    daily_limit: DAILY_LIMIT,
    remaining_units: remaining,
    uploads_that_fit: Math.floor(remaining / UPLOAD_COST),
    resets_in_hours: hoursToReset,
    note: "Estimate from calls made through this plugin only; other tools sharing the Google Cloud project, or a failed call that cost more, are not counted. Check the Cloud console for the exact figure.",
  };
}
