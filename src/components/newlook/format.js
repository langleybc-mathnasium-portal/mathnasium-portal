/**
 * Formatting helpers for the new-look home pages.
 *
 * Split out of ui.jsx because a file that exports components must export
 * ONLY components — mixing helpers in breaks React Fast Refresh, and the
 * lint rule that says so is right.
 */

export function fmtTime(t) {
  if (!t) return '';
  const [hStr, mStr] = String(t).split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h)) return String(t);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m ? `${h}:${String(m).padStart(2, '0')} ${ampm}` : `${h}:00 ${ampm}`;
}

/** Local-noon parse. A bare YYYY-MM-DD is UTC midnight, i.e. yesterday here. */
export function asDate(iso) {
  return new Date(`${iso}T12:00:00`);
}

export function fmtDay(iso, opts = { weekday: 'long', month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  return asDate(iso).toLocaleDateString('en-CA', opts);
}

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Minutes past midnight for "HH:MM". Null when unreadable. */
export function minutesOf(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
