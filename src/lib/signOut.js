/**
 * signOut.js — "signed in, never signed out".
 *
 * THE PROBLEM THIS SOLVES
 *   An instructor taps in on Radius, teaches, and walks out without tapping
 *   out. Radius exports that row with a Time In and a blank Time Out.
 *
 *   The payroll importer used to drop those rows on the floor: with no Time
 *   Out it couldn't compute a duration, so `Number.isFinite(actualHours)`
 *   was false and the row was skipped at parse time. The shift then matched
 *   no Radius row at all and rendered as "Not in Radius" — which reads as
 *   *they never came in*, the opposite of what happened. Someone who worked
 *   a full Saturday looked like a no-show.
 *
 *   So an open punch is now a state of its own: kept, matched to its shift,
 *   and shown as "signed in, no sign-out". The person can confirm their own
 *   sign-out time from an emailed link, and that confirmation is marked as
 *   self-reported so payroll can still look it over.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 *   This never decides pay on its own. A confirmed sign-out fills in the
 *   missing half of a punch; the admin still sees the row, still sees who
 *   supplied the time, and still sets Payroll h. "Auto-update" means the
 *   number stops being wrong, not that it stops being checked.
 */

/** How long an emailed confirm link stays good. */
export const SIGNOUT_TTL_DAYS = 14;

/** Who supplied a sign-out time. Stored on the shift as `signOutConfirmedBy`. */
export const CONFIRMED_BY_INSTRUCTOR = 'instructor';
export const CONFIRMED_BY_ADMIN = 'admin';

/**
 * Minutes past midnight for a clock reading, or null.
 *
 * Radius is inconsistent across export versions — "9:02 AM", "09:02",
 * "17:30" have all been seen in the same column — so both 12- and 24-hour
 * forms are accepted.
 */
export function toMinutes(str) {
  if (str == null) return null;
  const m = String(str).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  if (h > 23) return null;
  return h * 60 + min;
}

/** "9:02 AM" -> "09:02". Null when unparseable, so callers can tell. */
export function toHHMM(str) {
  const mins = toMinutes(str);
  if (mins == null) return null;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Decimal hours between two clock readings, wrapping past midnight.
 * Null when either side is unreadable.
 */
export function hoursBetween(inStr, outStr) {
  const a = toMinutes(inStr);
  const b = toMinutes(outStr);
  if (a == null || b == null) return null;
  let diff = b - a;
  if (diff < 0) diff += 24 * 60;          // crossed midnight
  return Math.round((diff / 60) * 100) / 100;
}

/**
 * Did they tap in without tapping out?
 *
 * Requires a readable Time In and an unreadable/absent Time Out. A row with
 * neither is not an open punch — it's a summary line or junk, and the
 * importer's own filters deal with it.
 */
export function isOpenPunch(row) {
  if (!row) return false;
  return toMinutes(row.timeIn) != null && toMinutes(row.timeOut) == null;
}

/**
 * The sign-out time to use for a shift, and where it came from.
 *
 * Precedence, strongest evidence first:
 *   1. A real Radius tap-out.
 *   2. A sign-out the instructor confirmed from their email.
 *   3. Nothing — still open.
 *
 * An admin editing the Time Out box in the payroll table lands in case 1,
 * because that edit rewrites the Radius row itself.
 */
export function effectiveSignOut(row, shift) {
  const punched = toHHMM(row?.timeOut);
  if (punched) return { time: punched, source: 'radius' };
  const confirmed = toHHMM(shift?.signOutConfirmedTime);
  if (confirmed) {
    return {
      time: confirmed,
      source: 'confirmed',
      by: shift.signOutConfirmedBy || CONFIRMED_BY_INSTRUCTOR,
      at: shift.signOutConfirmedAt || null,
    };
  }
  return { time: null, source: 'none' };
}

/**
 * One label for how a payroll row's clock data stands. The payroll table
 * renders from this rather than re-deriving the same booleans in four
 * places — which is how "Not in Radius" ended up covering two very
 * different situations in the first place.
 *
 *   'upcoming'      shift hasn't happened; no clock data is expected
 *   'absent'        no Radius row at all — genuinely didn't clock in
 *   'open'          tapped in, never tapped out, nobody has confirmed
 *   'self-confirmed' tapped in, and the instructor supplied the sign-out
 *   'complete'      a full Radius punch
 */
export function signOutState({ match, shift, isFuture = false }) {
  if (!match) return isFuture ? 'upcoming' : 'absent';
  if (toMinutes(match.timeOut) != null) return 'complete';
  if (toHHMM(shift?.signOutConfirmedTime)) return 'self-confirmed';
  return 'open';
}

/** Rows the admin can send a confirm request for: open, and already past. */
export function needsSignOutRequest(state) {
  return state === 'open';
}

/**
 * Hours for a shift once a confirmed sign-out is folded in — or null when
 * there still isn't one, so the caller keeps showing the row as open rather
 * than inventing a number.
 */
export function resolvedActualHours(row, shift) {
  const { time } = effectiveSignOut(row, shift);
  if (!time) return null;
  return hoursBetween(row?.timeIn, time);
}

/**
 * The confirm token doc written when an admin sends the request.
 *
 * The token is the DOCUMENT ID, not a field — so a lookup is a direct get()
 * with no query, and a wrong guess simply doesn't exist. `expiresAt` and
 * `usedAt` are both enforced server-side on redemption; they're stored here
 * so an expired request is legible to a human reading the collection.
 */
export function buildSignOutRequest({ shift, row, user, centerId, requestedBy, now = new Date() }) {
  const expires = new Date(now.getTime() + SIGNOUT_TTL_DAYS * 86400000);
  return {
    shiftId: shift.shiftId || shift.id,
    userId: user?.id || user?.uid || null,
    userName: user?.displayName || shift.name || null,
    centerId: centerId || null,
    date: shift.date,
    // What we're asking them to confirm — the scheduled end of the shift.
    proposedSignOut: toHHMM(shift.endTime),
    clockIn: toHHMM(row?.timeIn),
    status: 'pending',
    createdAt: now.toISOString(),
    createdBy: requestedBy || null,
    expiresAt: expires.toISOString(),
    usedAt: null,
  };
}

/** Is a stored request still redeemable? Mirrored server-side on redemption. */
export function isRequestRedeemable(reqDoc, now = new Date()) {
  if (!reqDoc) return false;
  if (reqDoc.usedAt) return false;
  if (reqDoc.status && reqDoc.status !== 'pending') return false;
  if (!reqDoc.expiresAt) return false;
  return new Date(reqDoc.expiresAt).getTime() > now.getTime();
}

/**
 * A cryptographically random token, URL-safe.
 *
 * 32 bytes / 256 bits — brute-forcing it is not a threat model, which
 * matters because possession of the token is the entire authorisation for
 * the confirm endpoint. Works in the browser and in Node 19+.
 */
export function newSignOutToken(cryptoObj = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  cryptoObj.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Does this payroll row still want a human's eyes?
 *
 * One definition, used by the unresolved counter, the person-level badge
 * and the row highlight — they had three copies of the same boolean, which
 * is how an open punch ended up counted in some places and not others.
 *
 * A self-confirmed sign-out counts as outstanding on purpose. The
 * instructor filling in their own missing tap-out is a reasonable answer,
 * not a verified one, and it stays flagged until an admin marks the row
 * Resolved.
 */
export function payrollNeedsReview(s) {
  if (!s || s.noShow || s.isFuture || s.payrollResolved) return false;
  if (s.shiftDiscrepancy || s.missingFromRadius) return true;
  return s.signOutState === 'open' || s.signOutState === 'self-confirmed';
}
