/**
 * ratioShape.js — turning "N instructors, M students" into something drawable.
 *
 * Kept separate from the component so the arithmetic is testable. The
 * thresholds are the centre's settled policy, not new invention:
 *
 *   aim   1:3.5   — what the scheduler targets
 *   floor 1:4     — the line the centre does not cross
 *
 * (See CLAUDE.md, "Rules that are settled".) Nothing here decides staffing;
 * it only decides how a number is drawn.
 */

export const RATIO_AIM = 3.5;
export const RATIO_FLOOR = 4;

/** Students per instructor, or null when the question doesn't apply yet. */
export function ratioOf(instructors, students) {
  // `Number(null)` is 0, not NaN — so a count that simply hasn't loaded yet
  // would read as "zero instructors", i.e. the students-with-nobody-on-them
  // emergency, flashing red on every page load. Reject absent values first.
  if (instructors == null || students == null
    || instructors === '' || students === '') return null;
  const i = Number(instructors);
  const s = Number(students);
  if (!Number.isFinite(i) || !Number.isFinite(s)) return null;
  if (i <= 0) return s > 0 ? Infinity : null;   // students with nobody on them
  if (s <= 0) return 0;
  return s / i;
}

/**
 * How a ratio reads.
 *   'ok'    at or under the 1:3.5 aim
 *   'warn'  past the aim but still inside the 1:4 floor
 *   'over'  past the floor — the state the centre exists to avoid
 *   null    nothing to say yet
 */
export function ratioHealth(ratio) {
  if (ratio == null) return null;
  if (ratio === 0) return 'ok';
  if (ratio <= RATIO_AIM) return 'ok';
  if (ratio <= RATIO_FLOOR) return 'warn';
  return 'over';
}

/**
 * The dots for ONE instructor's share of the room.
 *
 * Drawing every person is a crowd, not a glance — four instructors and
 * fourteen students is eighteen dots. So this draws what one instructor
 * carries: their covered students, plus a dashed dot for the overflow when
 * the room is past the floor.
 *
 * Capped at eight so a badly understaffed hour can't blow out a phone
 * layout; the numeric label alongside carries the real figure.
 */
export function unitDots(instructors, students, cap = 8) {
  const ratio = ratioOf(instructors, students);
  if (ratio == null) return { covered: 0, uncovered: 0 };
  if (ratio === Infinity) return { covered: 0, uncovered: Math.min(cap, Number(students) || 1) };

  const share = Math.round(ratio * 10) / 10;
  const covered = Math.min(cap, Math.max(0, Math.floor(share)));
  // One dashed dot once the share passes the floor — the visual for
  // "somebody in this room isn't being covered".
  const uncovered = share > RATIO_FLOOR ? Math.min(cap - covered, Math.ceil(share - RATIO_FLOOR)) : 0;
  return { covered, uncovered: Math.max(0, uncovered) };
}
