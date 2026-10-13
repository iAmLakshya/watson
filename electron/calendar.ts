import { createHash } from 'node:crypto';
import type { CalendarAttendee, CalendarEvent } from '../shared/types';
function decode(value: string) { return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\'); }
function dateValue(value: string, zone?: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/); if (!match) throw new Error('Calendar contains an unsupported date');
  const parts = match.slice(1, 7).map(item => Number(item ?? 0)); let date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (!match[7] && zone) {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    // Resolve wall time in an IANA zone, including daylight-saving offsets.
    for (let attempt = 0; attempt < 3; attempt++) { const displayed = Object.fromEntries(formatter.formatToParts(date).map(item => [item.type, item.value])); const wall = Date.UTC(+displayed.year, +displayed.month - 1, +displayed.day, +displayed.hour, +displayed.minute, +displayed.second); const desired = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]); const difference = desired - wall; if (!difference) break; date = new Date(date.getTime() + difference); }
  } else if (!match[7]) date = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  return date.toISOString();
}
export function parseCalendar(text: string): { events: CalendarEvent[]; warnings: string[] } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n'); const events: CalendarEvent[] = []; const warnings: string[] = []; let properties: Map<string, { value: string; zone?: string }> | undefined; let attendees: CalendarAttendee[] = [];
  if (!lines.some(line => line.trim() === 'BEGIN:VCALENDAR')) throw new Error('Choose a valid .ics calendar file');
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { properties = new Map(); attendees = []; continue; }
    if (line === 'END:VEVENT' && properties) {
      const start = properties.get('DTSTART'); if (!start) { properties = undefined; continue; }
      const end = properties.get('DTEND'); const title = decode(properties.get('SUMMARY')?.value ?? 'Untitled meeting'); const description = decode(properties.get('DESCRIPTION')?.value ?? ''); const location = decode(properties.get('LOCATION')?.value ?? ''); const url = properties.get('URL')?.value;
      const joinUrl = [url, location, description].flatMap(value => value?.match(/https:\/\/[^\s<>"\\]+/g) ?? []).find(value => /(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)\//i.test(value));
      const startDate = dateValue(start.value, start.zone); const endDate = end ? dateValue(end.value, end.zone) : new Date(new Date(startDate).getTime() + 3600000).toISOString();
      const uid = properties.get('UID')?.value ?? `${title}-${startDate}`; const id = createHash('sha256').update(`${uid}-${startDate}`).digest('hex').slice(0, 24);
      events.push({ id, title, description, start: startDate, end: endDate, location, joinUrl, attendees });
      if (properties.has('RRULE')) warnings.push(`${title}: imported the listed occurrence; recurring event expansion requires a calendar connection.`);
      properties = undefined; continue;
    }
    if (!properties) continue; let quoted = false; let escaped = false; let colon = -1;
    for (let index = 0; index < line.length; index++) { const character = line[index]; if (escaped) { escaped = false; continue; } if (character === '\\') { escaped = true; continue; } if (character === '"') quoted = !quoted; if (character === ':' && !quoted) { colon = index; break; } }
    if (colon < 0) continue; const header = line.slice(0, colon).match(/(?:[^;"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? []; const [name, ...parameters] = header; if (!name) continue; const value = line.slice(colon + 1); const parameter = (key: string) => parameters.find(item => item.toUpperCase().startsWith(`${key}=`))?.slice(key.length + 1).replace(/^"|"$/g, ''); const zone = parameter('TZID');
    if (name.toUpperCase() === 'ATTENDEE' && /^mailto:/i.test(value)) { let email: string; try { email = decodeURIComponent(value.slice(7).split('?')[0]).trim().toLowerCase(); } catch { continue; } if (/^[^\s@]+@[^\s@]+$/.test(email) && !attendees.some(attendee => attendee.email === email)) attendees.push({ email, name: parameter('CN') ? decode(parameter('CN')!) : undefined }); }
    properties.set(name.toUpperCase(), { value, zone });
  }
  return { events, warnings };
}
