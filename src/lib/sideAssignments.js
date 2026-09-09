/**
 * sideAssignments.js — "which side am I on, and when do I move?"
 *
 * THE QUESTION THIS ANSWERS
 *   Neeru assigns instructors to a side — High School or Elementary — for
 *   each half-hour of the day, in the Student Scheduler, before the day
 *   arrives. Until now that assignment lived only on her screen and the
 *   printed sheet, so instructors walked in asking "which side am I on
 *   today?" and "when do I switch?". The answer already exists; it just
 *   wasn't anywhere they could see it.
 *
 * THE DATA
 *   `centers/{id}/schedulerInstructorAssignments/{YYYY-MM-DD}` is a flat
 *   map keyed `"<side>|<HH:MM>"` holding an array of DISPLAY NAMES:
 *
 *     { "EM|15:00": ["Kaitlyn MacDonald", "Dev Mistry"],
 *       "HS|17:00": ["Luke Huang", "Jason Soo"] }
 *
 *   Verified against 73 live documents: sides are only ever HS and EM,
 *   slots are half-hourly 10:00–18:30, and no other keys appear. Slots are
 *   sparse — a half hour nobody is assigned to simply has no entry.
 *
 * WHAT THIS DOES
 *   Pulls one person's slots out and collapses consecutive ones on the same
 *   side into blocks, so "EM 15:00, EM 15:30, EM 16:00, HS 16:30" reads as
 *   "3:00–4:30 Elementary, then 4:30–5:00 High School" — which is the shape
 *   of the question being asked.
 */

export const SLOT_MINUTES = 30;

export const SIDES = {
  HS: { key: 'HS', label: 'High School', short: 'HS' },
  EM: { key: 'EM', label: 'Elementary', short: 'EM' },
};

export function sideLabel(side) {
  return SIDES[side]?.label || side || '';
}

/** "15:30" -> 930. Null when unreadable. */
export function slotToMinutes(slot) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(slot || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 930 -> "15:30". */
export function minutesToSlot(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Names compare on trimmed, collapsed, lower case — never on punctuation. */
function normName(n) {
  return String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Does an assignment name refer to this person?
 *
 * Exact display name is the rule, and it covers every current member of
 * staff — checked against every live assignment document.
 *
 * The one concession is a bare first name: the historical data contains
 * "Bri", "Sabrina", "Sofie", so the sheet is sometimes filled in with
 * short names. That is accepted ONLY when exactly one person at the centre
 * has that first name. If two people share it the entry is ignored, because
 * telling somebody they are on the wrong side is worse than telling them
 * nothing — they would walk to the wrong end of the room and trust it.
 *
 * @param {string} entry     a name as typed on the sheet
 * @param {string} fullName  the person's Ratio displayName
 * @param {string[]} roster  every current staff displayName at the centre
 */
export function nameMatches(entry, fullName, roster = []) {
  const e = normName(entry);
  const full = normName(fullName);
  if (!e || !full) return false;
  if (e === full) return true;

  // Bare first name, and only if it is unambiguous across the roster.
  if (!e.includes(' ')) {
    const first = full.split(' ')[0];
    if (e !== first) return false;
    const sharing = roster.filter(n => normName(n).split(' ')[0] === e);
    return sharing.length === 1;
  }
  return false;
}

/**
 * Every slot one person is assigned to, as `{ slot, minutes, side }`,
 * ordered through the day.
 *
 * A person assigned to BOTH sides in the same half hour is a data error
 * (Neeru would have to tick them twice); the entry is kept once, first
 * side wins, rather than silently producing two overlapping blocks.
 */
export function slotsForPerson(assignments, fullName, roster = []) {
  const out = [];
  const seen = new Set();
  for (const [key, names] of Object.entries(assignments || {})) {
    if (!Array.isArray(names)) continue;
    const [side, slot] = String(key).split('|');
    if (!side || !slot) continue;
    const minutes = slotToMinutes(slot);
    if (minutes == null) continue;
    if (!names.some(n => nameMatches(n, fullName, roster))) continue;
    if (seen.has(minutes)) continue;
    seen.add(minutes);
    out.push({ slot, minutes, side });
  }
  return out.sort((a, b) => a.minutes - b.minutes);
}

/**
 * Collapse consecutive same-side slots into blocks.
 *
 * A gap in the middle of the day genuinely breaks the block — that is a
 * half hour the person is not assigned anywhere, and merging across it
 * would invent an assignment that does not exist.
 *
 * @returns {Array<{ side, startMin, endMin, start, end }>}
 */
export function blocksForPerson(assignments, fullName, roster = []) {
  const slots = slotsForPerson(assignments, fullName, roster);
  const blocks = [];
  for (const s of slots) {
    const last = blocks[blocks.length - 1];
    const contiguous = last && last.side === s.side && last.endMin === s.minutes;
    if (contiguous) {
      last.endMin = s.minutes + SLOT_MINUTES;
      last.end = minutesToSlot(last.endMin);
    } else {
      blocks.push({
        side: s.side,
        startMin: s.minutes,
        endMin: s.minutes + SLOT_MINUTES,
        start: s.slot,
        end: minutesToSlot(s.minutes + SLOT_MINUTES),
      });
    }
  }
  return blocks;
}

/** Which block covers `minutes` right now, or null. */
export function blockAt(blocks, minutes) {
  if (!Number.isFinite(minutes)) return null;
  return (blocks || []).find(b => minutes >= b.startMin && minutes < b.endMin) || null;
}

/**
 * The next time this person changes side, as a block, or null when they
 * stay put for the rest of the day.
 *
 * A gap followed by the SAME side is not a switch — they were simply
 * unassigned for a while, and calling that "you move to Elementary at
 * 5:30" when they were already on Elementary would be wrong.
 */
export function nextSwitch(blocks, minutes) {
  const list = blocks || [];
  if (list.length === 0) return null;

  // Before the first block, nothing is a "move" — they haven't started.
  // Without this, someone on one side all day was told "you move to High
  // School at 5:00" while they were still at home, which is both wrong and
  // the exact confusion this feature exists to remove.
  if (minutes < list[0].startMin) return null;

  const current = blockAt(list, minutes);
  const upcoming = list.filter(b => b.startMin > (current ? current.startMin : minutes));
  for (const b of upcoming) {
    // In a GAP between blocks (current is null but the day has begun),
    // the next block genuinely is where they go next — worth saying.
    if (!current || b.side !== current.side) return b;
    // Same side after a gap is not a change; keep looking for a real one.
  }
  return null;
}

/** Did this person work both sides today? The "and when do I transfer" case. */
export function hasSwitch(blocks) {
  const sides = new Set((blocks || []).map(b => b.side));
  return sides.size > 1;
}
