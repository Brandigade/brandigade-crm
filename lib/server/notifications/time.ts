// Time zone helpers for task notifications.
//
// Due dates in the CRM are "naive": a calendar date and an optional time of
// day, typed without a zone. They mean that date/time in the TEAM's time zone
// (workspaces.settings.timezone), exactly as the old send-due-task-emails
// function read them. Personal settings (digest hour, the time zone used to
// show times in emails) use the person's own zone.
//
// The old naiveLocalToUtc() read the zone offset at the wrong instant (the
// naive time taken as UTC), so for a few hours around a daylight saving change
// it could be an hour off. This version resolves the offset properly and
// handles the two DST edge cases the same way as Temporal's "compatible" mode:
//   * a time that doesn't exist (clocks jump forward, e.g. 02:30) moves
//     forward by the gap (02:30 -> 03:30 new time);
//   * a time that happens twice (clocks go back, e.g. 01:30) is the first one.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

/** The zone name if the runtime knows it, else null. */
export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== "string") return null;
  const name = tz.trim();
  if (!name || name.length > 64) return null;
  try {
    partsFormatter(name);
    return name;
  } catch {
    return null;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
  /** "yyyy-mm-dd" */
  date: string;
  /** "HH:MM" */
  time: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Wall-clock date and time of an instant in a time zone. */
export function localParts(instant: Date | number, timeZone: string): LocalParts {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  const out: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(ms))) out[p.type] = p.value;
  const hour = Number(out.hour) % 24; // some engines print midnight as "24"
  const parts = {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday),
  };
  return { ...parts, date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, time: `${pad(hour)}:${pad(parts.minute)}` };
}

/** Offset of the zone from UTC at an instant, in ms (Karachi: +5 h). */
export function tzOffsetMs(instant: number, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** "10:00:00" / "9:5" / null -> "10:00" / "" (the form used in dedupe keys). */
export function normalizeTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const m = TIME_RE.exec(value.trim());
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return "";
  return `${pad(h)}:${pad(min)}`;
}

/** A valid "yyyy-mm-dd" (first 10 characters of a date/timestamp), else null. */
export function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.slice(0, 10);
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? s : null;
}

/**
 * The instant a naive date (+ optional "HH:MM") means in a time zone.
 * No time = the start of that day (00:00), like the old function.
 */
export function naiveLocalToUtc(date: string, time: string | null | undefined, timeZone: string): Date {
  const d = normalizeDate(date);
  if (!d) throw new Error(`Invalid date: ${date}`);
  const t = normalizeTime(time) || "00:00";
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, da, h, mi);
  // Offsets a day either side cover any single DST change around this time.
  const before = tzOffsetMs(naive - DAY, timeZone);
  const after = tzOffsetMs(naive + DAY, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => naive - offset)
    .filter((instant) => naive - tzOffsetMs(instant, timeZone) === instant)
    .sort((a, b) => a - b);
  if (candidates.length) return new Date(candidates[0]); // normal time, or the first of a repeated hour
  return new Date(naive - before); // inside a gap: shift forward by the gap
}

/** "2026-10-31" + 1 -> "2026-11-01". */
export function addDays(date: string, days: number): string {
  const d = normalizeDate(date);
  if (!d) throw new Error(`Invalid date: ${date}`);
  const [y, m, da] = d.split("-").map(Number);
  const out = new Date(Date.UTC(y, m - 1, da + days));
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`;
}

/** "Asia/Karachi" -> "Karachi time", "UTC" -> "UTC". */
export function zoneLabel(timeZone: string): string {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  if (timeZone.startsWith("Etc/")) return timeZone.slice(4);
  const city = timeZone.split("/").pop() || timeZone;
  return `${city.replace(/_/g, " ")} time`;
}

/** "Mon 19 Oct 2026" for a naive date. */
export function formatDate(date: string): string {
  const d = normalizeDate(date);
  if (!d) return String(date);
  const [y, m, da] = d.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, da)).getUTCDay();
  return `${WEEKDAYS[wd]} ${da} ${MONTHS[m - 1]} ${y}`;
}

/** "Mon 19 Oct" (no year) for a naive date. */
export function formatShortDate(date: string): string {
  return formatDate(date).replace(/ \d{4}$/, "");
}

/** "10:00 AM" for "HH:MM". */
export function formatClock(time: string): string {
  const t = normalizeTime(time);
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h >= 12 ? "PM" : "AM"}`;
}

/** "Mon 19 Oct 2026, 10:00 AM" for an instant shown in a time zone. */
export function formatInstant(instant: Date | number, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${formatDate(p.date)}, ${formatClock(p.time)}`;
}

/** "15 min", "1 hour", "2 h 30 min", "3 days". */
export function humanizeDuration(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!rest) return h === 1 ? "1 hour" : `${h} hours`;
    return `${h} h ${rest} min`;
  }
  const days = Math.round(minutes / (24 * 60));
  return days === 1 ? "1 day" : `${days} days`;
}
