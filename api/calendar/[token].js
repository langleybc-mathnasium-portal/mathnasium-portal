// GET /api/calendar/<token>.ics
//
// Per-user iCalendar (.ics) subscription feed. Instructors/employees add
// their personal link to Apple Calendar ("Add Subscription") or Google
// Calendar ("From URL") and their Ratio schedule syncs to their phone —
// one feed, every platform, read-only.
//
// AUTH — the token IS the auth.
//   Calendar apps can't send headers, so the secret lives in the URL. Each
//   user has a random `calendarToken` on their Firestore user doc; we look
//   them up by it. Rotating the token (Reset link in the app) invalidates
//   old subscriptions. Treat the URL like a password.
//
// CONTENTS (per the owner's choice): the user's published shifts as timed
//   events + their APPROVED time off as all-day events. Drafts, cancelled
//   shifts, and pending/denied time off are excluded.
//
// TIMEZONE — shifts are stored as centre-local wall-clock (`date` +
//   `startTime`/`endTime`). We convert each to a true UTC instant (DST-aware,
//   same math as api/cron/send-shift-reminders.js) and emit DTSTART/DTEND in
//   UTC, so no VTIMEZONE block is needed and every client renders the right
//   local time.
//
// REFRESH — Google/Apple re-poll subscribed feeds on their own schedule
//   (hours, up to a day). There is no push; changes appear within hours.
//
// SETUP — needs FIREBASE_SERVICE_ACCOUNT (already set for the other API
//   routes). CENTER_TZ env is used as the timezone fallback.

import { getFirestore } from '../_lib/firebase-admin.js';
import { centreOffsetYMD } from '../_lib/centreDate.js';

const TZ_FALLBACK = process.env.CENTER_TZ || 'America/Vancouver';

// How far back / ahead to include, so the feed stays small and fast.
const WINDOW_PAST_DAYS   = 45;
const WINDOW_FUTURE_DAYS = 365;

// ── Timezone math (centre-local wall clock → true UTC instant) ───────────
function tzOffsetMs(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - (date.getTime() - date.getMilliseconds());
}
function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number);
  const guess = new Date(Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0));
  const off1 = tzOffsetMs(timeZone, guess);
  let result = new Date(guess.getTime() - off1);
  const off2 = tzOffsetMs(timeZone, result);
  if (off2 !== off1) result = new Date(guess.getTime() - off2);
  return result;
}

// ── iCal formatting helpers ──────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
// JS Date → "YYYYMMDDTHHMMSSZ" (UTC form).
function icsUtc(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
// "YYYY-MM-DD" → "YYYYMMDD" (all-day DATE value), optionally + N days.
function icsDate(dateStr, addDays = 0) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (mo || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + addDays);
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}
// Escape per RFC 5545 (backslash, semicolon, comma, newlines).
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
// Fold a content line to <=75 octets with CRLF + space continuation.
function fold(line) {
  if (line.length <= 74) return line;
  const parts = [];
  let s = line;
  parts.push(s.slice(0, 74));
  s = s.slice(74);
  while (s.length > 0) { parts.push(' ' + s.slice(0, 73)); s = s.slice(73); }
  return parts.join('\r\n');
}

function shiftSummary(s) {
  if (s.flexRole) return `Ratio · ${s.flexRole}`;
  const lvl = s.subRole ? ` · ${s.subRole}` : '';
  if (s.sickPay) return `Ratio Shift (Sick)${lvl}`;
  return `Ratio Shift${lvl}`;
}

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method Not Allowed');
  }

  // Dynamic segment arrives as "<token>.ics"; strip the extension.
  const rawToken = String(req.query?.token || '').trim();
  const token = rawToken.replace(/\.ics$/i, '');
  if (!token || token.length < 8) {
    return res.status(404).send('Not found');
  }

  let db;
  try {
    db = getFirestore();
  } catch (err) {
    return res.status(500).send('Server not configured: ' + (err?.message || 'unknown'));
  }

  try {
    // Resolve the user by their secret calendar token.
    const userSnap = await db.collection('users').where('calendarToken', '==', token).limit(1).get();
    if (userSnap.empty) return res.status(404).send('Not found');
    const userDoc = userSnap.docs[0];
    const uid = userDoc.id;
    const user = userDoc.data() || {};
    const userName = user.displayName || 'Ratio';

    // Date window (centre-local calendar dates as plain YYYY-MM-DD strings).
    // These are compared against shift.date, which is centre-local wall
    // clock, so the edges have to be centre-local too — deriving them from
    // a UTC instant moved the whole window a day every evening.
    const lo = centreOffsetYMD(-WINDOW_PAST_DAYS);
    const hi = centreOffsetYMD(WINDOW_FUTURE_DAYS);

    // Pull the user's shifts + time-off.
    //
    // The shift read is bounded by the same window we're about to render.
    // Unbounded, it fetched every shift the person had EVER worked on every
    // poll — and calendar clients poll a subscribed feed every few minutes,
    // forever, so the cost grew with tenure and never came back down.
    //
    // The bound needs a (userId, date) composite index. Rather than make
    // this endpoint depend on a deploy that may not have happened yet, we
    // try the bounded query and fall back to the original unbounded read if
    // Firestore says the index is missing. Same output either way; the
    // fallback is just slower. Once `firebase deploy --only firestore:indexes`
    // has run, the fast path is the one that's taken.
    const shiftsForUser = async () => {
      try {
        return await db.collection('shifts')
          .where('userId', '==', uid)
          .where('date', '>=', lo)
          .where('date', '<=', hi)
          .get();
      } catch (err) {
        if (err?.code !== 9 && !/index/i.test(err?.message || '')) throw err;
        console.warn('[calendar] (userId,date) index missing — falling back to full read');
        return db.collection('shifts').where('userId', '==', uid).get();
      }
    };

    const [shiftSnap, toSnap] = await Promise.all([
      shiftsForUser(),
      db.collection('timeOffRequests').where('userId', '==', uid).get(),
    ]);

    const shifts = shiftSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(s => s.date && s.startTime && s.endTime)
      .filter(s => s.status !== 'draft' && s.status !== 'cancelled')
      .filter(s => s.date >= lo && s.date <= hi);

    const timeOff = toSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(t => t.status === 'approved' && t.startDate && t.endDate)
      .filter(t => t.endDate >= lo && t.startDate <= hi);

    // Resolve each centre's timezone once (usually a single centre).
    const tzCache = new Map();
    async function tzFor(centerId) {
      if (!centerId) return TZ_FALLBACK;
      if (tzCache.has(centerId)) return tzCache.get(centerId);
      let tz = TZ_FALLBACK;
      try {
        const cfg = await db.collection('centers').doc(centerId).collection('config').doc('main').get();
        if (cfg.exists && cfg.data()?.timezone) tz = cfg.data().timezone;
      } catch { /* fall back */ }
      tzCache.set(centerId, tz);
      return tz;
    }

    const now = new Date();
    const dtstamp = icsUtc(now);
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Ratio//Schedule Sync//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      fold(`X-WR-CALNAME:${esc(`Ratio — ${userName}`)}`),
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
      'X-PUBLISHED-TTL:PT1H',
    ];

    for (const s of shifts) {
      const tz = await tzFor(s.centerId);
      const start = zonedToUtc(s.date, s.startTime, tz);
      const end = zonedToUtc(s.date, s.endTime, tz);
      const descBits = [];
      if (s.role) descBits.push(`Role: ${s.role}`);
      if (s.subRole) descBits.push(`Level: ${s.subRole}`);
      if (s.flexRole) descBits.push(`Flex: ${s.flexRole}`);
      if (s.shiftType && s.shiftType !== 'In-Centre') descBits.push(s.shiftType);
      if (s.noShow) descBits.push('Marked no-show');
      lines.push(
        'BEGIN:VEVENT',
        `UID:shift-${s.id}@ratio-schedule`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${icsUtc(start)}`,
        `DTEND:${icsUtc(end)}`,
        fold(`SUMMARY:${esc(shiftSummary(s))}`),
        ...(descBits.length ? [fold(`DESCRIPTION:${esc(descBits.join(' · '))}`)] : []),
        'STATUS:CONFIRMED',
        'END:VEVENT',
      );
    }

    for (const t of timeOff) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:timeoff-${t.id}@ratio-schedule`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${icsDate(t.startDate)}`,
        `DTEND;VALUE=DATE:${icsDate(t.endDate, 1)}`, // all-day DTEND is exclusive
        fold(`SUMMARY:${esc(`Time Off${t.reason ? ` — ${t.reason}` : ''}`)}`),
        'TRANSP:TRANSPARENT',
        'STATUS:CONFIRMED',
        'END:VEVENT',
      );
    }

    lines.push('END:VCALENDAR');
    const body = lines.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="ratio-schedule.ics"');
    // Let Vercel's CDN and the calendar client cache for ~30 min.
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=1800');
    return res.status(200).send(body);
  } catch (err) {
    return res.status(500).send('Failed to build calendar: ' + (err?.message || 'unknown'));
  }
}
