import { describe, expect, it } from "vitest";
import {
  addDays,
  formatClock,
  formatDate,
  formatInstant,
  humanizeDuration,
  localParts,
  naiveLocalToUtc,
  normalizeDate,
  normalizeTime,
  tzOffsetMs,
  validTimeZone,
  zoneLabel,
} from "../../../lib/server/notifications/time.js";

const utc = (d: string, t: string, z: string) => naiveLocalToUtc(d, t, z).toISOString();

describe("naiveLocalToUtc", () => {
  it("reads a naive due date/time in the team's zone", () => {
    expect(utc("2026-10-17", "10:00", "Asia/Karachi")).toBe("2026-10-17T05:00:00.000Z");
    expect(utc("2026-10-17", "10:00", "UTC")).toBe("2026-10-17T10:00:00.000Z");
    expect(utc("2026-10-17", "", "Asia/Dubai")).toBe("2026-10-16T20:00:00.000Z"); // date only = 00:00
    expect(utc("2026-10-17", null as any, "Pacific/Kiritimati")).toBe("2026-10-16T10:00:00.000Z"); // UTC+14
    expect(utc("2026-10-17", "23:30", "Pacific/Pago_Pago")).toBe("2026-10-18T10:30:00.000Z"); // UTC-11
    expect(utc("2026-10-17", "09:15:00", "Asia/Kolkata")).toBe("2026-10-17T03:45:00.000Z"); // half-hour zone, Postgres "time" format
  });

  it("gets times right on daylight-saving days (northern hemisphere)", () => {
    // New York: clocks jump 02:00 EST -> 03:00 EDT on 8 Mar 2026 (07:00 UTC).
    expect(utc("2026-03-08", "01:30", "America/New_York")).toBe("2026-03-08T06:30:00.000Z");
    expect(utc("2026-03-08", "03:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    expect(utc("2026-03-08", "09:00", "America/New_York")).toBe("2026-03-08T13:00:00.000Z");
    // The old offset trick put 03:30 EDT at 08:30 UTC (an hour off).
    // New York: clocks go back 02:00 EDT -> 01:00 EST on 1 Nov 2026.
    expect(utc("2026-11-01", "00:30", "America/New_York")).toBe("2026-11-01T04:30:00.000Z");
    expect(utc("2026-11-01", "03:00", "America/New_York")).toBe("2026-11-01T08:00:00.000Z");
    // Berlin: 29 Mar 2026 02:00 CET -> 03:00 CEST; 25 Oct 2026 03:00 CEST -> 02:00 CET.
    expect(utc("2026-03-29", "01:30", "Europe/Berlin")).toBe("2026-03-29T00:30:00.000Z");
    expect(utc("2026-03-29", "03:30", "Europe/Berlin")).toBe("2026-03-29T01:30:00.000Z");
    expect(utc("2026-10-25", "03:30", "Europe/Berlin")).toBe("2026-10-25T02:30:00.000Z");
    expect(utc("2026-10-24", "10:00", "Europe/Berlin")).toBe("2026-10-24T08:00:00.000Z");
    expect(utc("2026-10-26", "10:00", "Europe/Berlin")).toBe("2026-10-26T09:00:00.000Z");
  });

  it("gets times right on daylight-saving days (southern hemisphere)", () => {
    // Sydney: 4 Oct 2026 02:00 AEST -> 03:00 AEDT; 5 Apr 2026 03:00 AEDT -> 02:00 AEST.
    expect(utc("2026-10-03", "10:00", "Australia/Sydney")).toBe("2026-10-03T00:00:00.000Z");
    expect(utc("2026-10-05", "10:00", "Australia/Sydney")).toBe("2026-10-04T23:00:00.000Z");
    expect(utc("2026-04-05", "09:00", "Australia/Sydney")).toBe("2026-04-04T23:00:00.000Z");
  });

  it("moves a time that doesn't exist forward by the gap", () => {
    expect(utc("2026-03-08", "02:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z"); // = 03:30 EDT
    expect(utc("2026-03-29", "02:30", "Europe/Berlin")).toBe("2026-03-29T01:30:00.000Z"); // = 03:30 CEST
    expect(utc("2026-10-04", "02:30", "Australia/Sydney")).toBe("2026-10-03T16:30:00.000Z"); // = 03:30 AEDT
  });

  it("takes the first of a repeated hour", () => {
    expect(utc("2026-11-01", "01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT
    expect(utc("2026-10-25", "02:30", "Europe/Berlin")).toBe("2026-10-25T00:30:00.000Z"); // 02:30 CEST
    expect(utc("2026-04-05", "02:30", "Australia/Sydney")).toBe("2026-04-04T15:30:00.000Z"); // 02:30 AEDT
  });

  it("round-trips every hour of a DST-changing month", () => {
    for (const zone of ["America/New_York", "Europe/Berlin", "Australia/Sydney", "Asia/Karachi"]) {
      for (let h = 0; h < 24 * 40; h += 1) {
        const instant = Date.UTC(2026, 2, 1) + h * 3_600_000;
        const p = localParts(instant, zone);
        const back = naiveLocalToUtc(p.date, p.time, zone).getTime();
        // Unique local times map back exactly; repeated ones map to the first occurrence.
        expect(back === instant || back === instant - 3_600_000).toBe(true);
      }
    }
  });

  it("rejects bad dates", () => {
    expect(() => naiveLocalToUtc("2026-02-30", "10:00", "UTC")).toThrow();
    expect(() => naiveLocalToUtc("not a date", "10:00", "UTC")).toThrow();
  });
});

describe("zone helpers", () => {
  it("validates zone names", () => {
    expect(validTimeZone("Asia/Karachi")).toBe("Asia/Karachi");
    expect(validTimeZone(" Europe/Berlin ")).toBe("Europe/Berlin");
    expect(validTimeZone("Mars/Olympus")).toBeNull();
    expect(validTimeZone("")).toBeNull();
    expect(validTimeZone(null)).toBeNull();
    expect(validTimeZone(42)).toBeNull();
  });
  it("reads local parts and offsets", () => {
    const p = localParts(Date.UTC(2026, 9, 17, 19, 0), "Asia/Karachi");
    expect(p).toMatchObject({ date: "2026-10-18", time: "00:00", weekday: 0, hour: 0 });
    expect(tzOffsetMs(Date.UTC(2026, 9, 17), "Asia/Karachi")).toBe(5 * 3_600_000);
    expect(tzOffsetMs(Date.UTC(2026, 6, 1), "America/New_York")).toBe(-4 * 3_600_000);
    expect(tzOffsetMs(Date.UTC(2026, 0, 1), "America/New_York")).toBe(-5 * 3_600_000);
  });
  it("normalizes dates and times", () => {
    expect(normalizeTime("10:00:00")).toBe("10:00");
    expect(normalizeTime("9:05")).toBe("09:05");
    expect(normalizeTime("25:00")).toBe("");
    expect(normalizeTime(null)).toBe("");
    expect(normalizeDate("2026-10-17T00:00:00Z")).toBe("2026-10-17");
    expect(normalizeDate("2026-13-01")).toBeNull();
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
  it("formats for people", () => {
    expect(formatDate("2026-10-19")).toBe("Mon 19 Oct 2026");
    expect(formatClock("00:05")).toBe("12:05 AM");
    expect(formatClock("13:30")).toBe("1:30 PM");
    expect(formatInstant(Date.UTC(2026, 9, 19, 5, 0), "Asia/Karachi")).toBe("Mon 19 Oct 2026, 10:00 AM");
    expect(zoneLabel("Asia/Karachi")).toBe("Karachi time");
    expect(zoneLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires time");
    expect(zoneLabel("UTC")).toBe("UTC");
    expect(humanizeDuration(15 * 60_000)).toBe("15 min");
    expect(humanizeDuration(3_600_000)).toBe("1 hour");
    expect(humanizeDuration(150 * 60_000)).toBe("2 h 30 min");
    expect(humanizeDuration(3 * 86_400_000)).toBe("3 days");
  });
});
