export function formatEventDate(value: string) {
  return new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}
export function formatEventDateRange(start: string, end?: string) {
  if (!end || end === start) return formatEventDate(start);
  return `${formatEventDate(start)} - ${formatEventDate(end)}`;
}
export function formatDateTime(value: string, timezone = "Australia/Melbourne") {
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}
type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function zonedDateTimeParts(value: Date, timezone: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute") };
}

function parseDateTimeLocal(value: string): DateTimeParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Enter a valid local date and time.");
  const parsed = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const calendarCheck = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute));
  if (
    calendarCheck.getUTCFullYear() !== parsed.year
    || calendarCheck.getUTCMonth() + 1 !== parsed.month
    || calendarCheck.getUTCDate() !== parsed.day
    || parsed.hour > 23
    || parsed.minute > 59
  ) throw new Error("Enter a valid local date and time.");
  return parsed;
}

function sameParts(left: DateTimeParts, right: DateTimeParts) {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

export function formatDateTimeLocalInput(value?: string, timezone = "Australia/Melbourne") {
  if (!value) return "";
  const parts = zonedDateTimeParts(new Date(value), timezone);
  const two = (part: number) => String(part).padStart(2, "0");
  return `${parts.year}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}`;
}

export function dateTimeLocalInputToIso(value: string, timezone = "Australia/Melbourne") {
  if (!value) return undefined;
  const requested = parseDateTimeLocal(value);
  const wallTimeAsUtc = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
  );
  const matches: number[] = [];
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = wallTimeAsUtc - offsetMinutes * 60_000;
    if (sameParts(zonedDateTimeParts(new Date(candidate), timezone), requested)) matches.push(candidate);
  }
  const unique = [...new Set(matches)];
  if (!unique.length) throw new Error(`That local time does not exist in ${timezone} because of daylight saving.`);
  if (unique.length > 1) throw new Error(`That local time occurs twice in ${timezone}; choose an unambiguous time.`);
  return new Date(unique[0]).toISOString();
}
export function moneyCents(value: number, currency = "AUD") {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency, maximumFractionDigits: value % 100 === 0 ? 0 : 2 }).format(value / 100);
}
export function money(value: number, currency = "AUD") { return moneyCents(Math.round(value * 100), currency); }
export function slugify(value: string) { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
export function safeUrl(value: string) { if (!value) return ""; if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value; try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? value : ""; } catch { return ""; } }
export function statusLabel(value: string) { return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
