export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

const RELATIVE = /^now\s*(?:-\s*(\d+)\s*([smhd]))?$/i;
const AGO = /^(\d+)\s*([smhd])\s*ago$/i;
const UNIT_MS: Record<string, number> = { s: 1000, m: MINUTE, h: HOUR, d: 24 * HOUR };

export function parseTime(input: string | number | undefined | null, now = Date.now()): number | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input === "number") return Number.isFinite(input) ? normalizeEpoch(input) : undefined;

  const s = input.trim();
  if (/^\d{10,13}$/.test(s)) return normalizeEpoch(Number(s));

  const rel = RELATIVE.exec(s);
  if (rel) return rel[1] ? now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()] : now;

  const ago = AGO.exec(s);
  if (ago) return now - Number(ago[1]) * UNIT_MS[ago[2].toLowerCase()];

  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hhmm) {
    const d = new Date(now);
    d.setUTCHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0);
    return d.getTime();
  }

  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeEpoch(n: number): number {
  return n < 1e12 ? n * 1000 : n;
}

export interface Window {
  start: number;
  end: number;
}

export function resolveWindow(
  start: string | number | undefined,
  end: string | number | undefined,
  now = Date.now(),
  defaultMs = 3 * HOUR,
): Window {
  const e = Math.min(parseTime(end, now) ?? now, now);
  let s = parseTime(start, now) ?? e - defaultMs;
  if (s >= e) s = e - defaultMs;
  return { start: s, end: e };
}

export function iso(ts: number | null | undefined): string {
  return ts ? new Date(ts).toISOString().replace(".000Z", "Z") : "n/a";
}

export function floorMinute(ts: number): number {
  return Math.floor(ts / MINUTE) * MINUTE;
}
