/**
 * iCalendar (.ics) helpers for Google / Apple Calendar export & sync.
 * All event times are emitted as UTC (`Z` suffix).
 */

export type IcsLessonEvent = {
  id: string;
  title: string | null;
  scheduledAt: string | Date;
  durationMinutes?: number | null;
  description?: string;
  location?: string;
};

const DEFAULT_DURATION_MINUTES = 50;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a Date as UTC iCal datetime: YYYYMMDDTHHMMSSZ */
export function toIcsUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
  );
}

/** Format for Google Calendar template `dates=` param (UTC compact). */
export function toGoogleCalendarUtc(date: Date): string {
  return toIcsUtc(date).replace(/Z$/, "");
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function foldLine(line: string): string {
  // RFC 5545 line folding at 75 octets — ASCII-safe fold for our payloads.
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let remaining = line;
  chunks.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length > 0) {
    chunks.push(` ${remaining.slice(0, 74)}`);
    remaining = remaining.slice(74);
  }
  return chunks.join("\r\n");
}

export function buildGoogleCalendarUrl(event: IcsLessonEvent): string {
  const start = new Date(event.scheduledAt);
  const duration = event.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  const end = new Date(start.getTime() + duration * 60 * 1000);
  const title = event.title?.trim() || "שיעור פרטי";
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${toGoogleCalendarUtc(start)}/${toGoogleCalendarUtc(end)}`,
  });
  if (event.description) params.set("details", event.description);
  if (event.location) params.set("location", event.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function buildIcsCalendar(
  events: IcsLessonEvent[],
  calendarName = "PROJECT100 Lessons"
): string {
  const now = toIcsUtc(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Project8//Lessons//HE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
  ];

  for (const event of events) {
    const start = new Date(event.scheduledAt);
    const duration = event.durationMinutes ?? DEFAULT_DURATION_MINUTES;
    const end = new Date(start.getTime() + duration * 60 * 1000);
    const title = event.title?.trim() || "שיעור פרטי";
    const uid = `${event.id}@project8`;

    lines.push("BEGIN:VEVENT");
    lines.push(foldLine(`UID:${uid}`));
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${toIcsUtc(start)}`);
    lines.push(`DTEND:${toIcsUtc(end)}`);
    lines.push(foldLine(`SUMMARY:${escapeIcsText(title)}`));
    if (event.description) {
      lines.push(foldLine(`DESCRIPTION:${escapeIcsText(event.description)}`));
    }
    if (event.location) {
      lines.push(foldLine(`LOCATION:${escapeIcsText(event.location)}`));
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/** Trigger a browser download of an .ics file. */
export function downloadIcsFile(icsBody: string, filename = "lessons.ics"): void {
  const blob = new Blob([icsBody], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** Build a webcal:// subscription URL pointing at the authenticated export feed. */
export function buildWebcalUrl(origin: string, path = "/api/calendar/export"): string {
  const httpsUrl = new URL(path, origin);
  return httpsUrl.toString().replace(/^https:/i, "webcal:").replace(/^http:/i, "webcal:");
}
