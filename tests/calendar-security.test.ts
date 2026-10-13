import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendar } from '../electron/calendar';
import { safeExternalUrl, validateSettings } from '../electron/validation';
test('calendar imports folded text, escapes, timezone dates, joins, and warns about recurrence', () => {
  const parsed = parseCalendar('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:event-1\r\nSUMMARY:Project\, review\r\nDTSTART;TZID=Europe/London:20261011T130000\r\nDTEND;TZID=Europe/London:20261011T140000\r\nDESCRIPTION:Discuss rollout\\nJoin https://meet.google.com/abc-\r\n defg-hij\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.equal(parsed.events[0].start, '2026-10-11T12:00:00.000Z'); assert.equal(parsed.events[0].end, '2026-10-11T13:00:00.000Z'); assert.equal(parsed.events[0].joinUrl, 'https://meet.google.com/abc-defg-hij'); assert.match(parsed.events[0].description, /rollout\nJoin/); assert.equal(parsed.warnings.length, 1);
});
test('external URL allowlist excludes executable protocols and local files', () => {
  assert.equal(safeExternalUrl('https://example.org/page'), 'https://example.org/page'); for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.org', 'data:text/html,test']) assert.throws(() => safeExternalUrl(url), /Only HTTPS/);
});
test('calendar participant parsing preserves repeated attendees and quoted names without treating them as actual attendance', () => {
  const parsed = parseCalendar('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:attendees\nSUMMARY:Review\nDTSTART:20261012T090000Z\nDTEND:20261012T100000Z\nATTENDEE;CN="Runtime reviewer":mailto:reviewer@example.org\nATTENDEE;CN="Patel: Priya\\, Team; A":mailto:priya%40example.org\nATTENDEE;CN=Duplicate:MAILTO:reviewer@example.org\nEND:VEVENT\nEND:VCALENDAR');
  assert.deepEqual(parsed.events[0].attendees, [{ name: 'Runtime reviewer', email: 'reviewer@example.org' }, { name: 'Patel: Priya, Team; A', email: 'priya@example.org' }]);
});
test('settings enforce bounded opacity, known keys, and known shortcut actions', () => {
  assert.throws(() => validateSettings({ opacity: NaN })); assert.throws(() => validateSettings({ opacity: 2 })); assert.throws(() => validateSettings({ credentials: 'secret' })); assert.throws(() => validateSettings({ shortcuts: { execute: 'sh' } })); assert.deepEqual(validateSettings({ theme: 'light', captureMicrophone: false, shortcuts: { assist: '' } }), { theme: 'light', captureMicrophone: false, shortcuts: { assist: '' } });
});
