/** Calendar dates as `YYYY-MM-DD` strings, handled in UTC so DST never shifts a day. */

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `YYYY-MM-DD` naming a real calendar day (2026-02-30 is not one). */
export function isIsoDate(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const ms = toMs(s);
	return !Number.isNaN(ms) && fromMs(ms) === s;
}

function toMs(date: string): number {
	const [y, m, d] = date.split("-").map(Number);
	return Date.UTC(y, m - 1, d);
}

function fromMs(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
	return fromMs(toMs(date) + n * DAY_MS);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
	return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

export function weekday(date: string): string {
	return WEEKDAYS[new Date(toMs(date)).getUTCDay()];
}

/** Today's local calendar date. */
export function today(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** Every date from `start` to `end` inclusive, in order. Empty when `end` is before `start`. */
export function dateRange(start: string, end: string): string[] {
	const n = daysBetween(start, end);
	if (n < 0) return [];
	return Array.from({ length: n + 1 }, (_, i) => addDays(start, i));
}
