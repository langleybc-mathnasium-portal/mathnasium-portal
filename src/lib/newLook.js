/**
 * newLook.js — the opt-in switch for the role-shaped home pages.
 *
 * WHAT THIS IS
 *   The portal has one front door, shaped like an owner's tool. An
 *   instructor gets it on a phone with most of it locked; a host gets a
 *   page built for someone sitting down doing payroll, while standing at a
 *   desk. "New look" replaces the single Home with four, one per job.
 *
 * WHY IT IS OPT-IN AND NOT A DEPLOY
 *   33 people use this portal during shifts. Nobody should meet a
 *   redesigned tool mid-session because a deploy landed. Classic stays the
 *   default; a person turns this on for themselves and it sticks. That also
 *   makes reverting a non-event — turning it off is a click, not a release.
 *
 *   The git history is the second escape hatch: this all arrived as one
 *   commit, so `git revert` removes it whole.
 *
 * PER-UID ON PURPOSE
 *   The preference is keyed by uid, so signing out of one account and into
 *   another on the same laptop doesn't carry the setting across. That
 *   matters right now specifically: the person evaluating this is going to
 *   log in as an instructor, a host, a director and an owner in turn, and
 *   each of those should start where that role's staff would start.
 */

const KEY_PREFIX = 'ratio-new-look:';

/** localStorage, but never throws — private mode and blocked storage exist. */
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function newLookKey(uid) {
  return `${KEY_PREFIX}${uid || 'anon'}`;
}

/** Is the new look on for this person? Off unless they turned it on. */
export function isNewLookOn(uid) {
  return read(newLookKey(uid)) === 'on';
}

/** Turn it on or off for this person. Returns the new state. */
export function setNewLook(uid, on) {
  write(newLookKey(uid), on ? 'on' : 'off');
  return !!on;
}

/**
 * The four doors.
 *
 * `owner`      — outcomes. Leads, enrolment, cost against budget.
 * `director`   — the week. What is going to go wrong and who fixes it.
 * `host`       — right now. Who is on the floor, who is due, who is waiting.
 * `instructor` — am I on today, and does anyone need anything from me.
 */
export const DOORS = ['owner', 'director', 'host', 'instructor'];

export const DOOR_LABELS = {
  owner:      'Centre',
  director:   'This week',
  host:       'Front desk',
  instructor: 'My shifts',
};

/**
 * Every door a person is entitled to, most senior first.
 *
 * Entitlement mirrors what the app already allows — this grants nothing.
 * `canSeeAdminPanel` is the same permission that reveals the admin pages
 * today, so a centre role built in Manage Roles gets the director door
 * without anyone editing this file.
 *
 * Everyone gets `instructor`, including owners: they still have shifts, and
 * "when am I in" is a fair question for anybody.
 */
export function doorsFor(auth = {}) {
  const {
    isSuperAdmin, isOwner, isDirector, isAdminAssistant,
    isHost, canSeeAdminPanel,
  } = auth;

  const doors = [];
  if (isSuperAdmin || isOwner) doors.push('owner');
  if (isDirector || isAdminAssistant || canSeeAdminPanel) doors.push('director');
  if (isHost) doors.push('host');
  doors.push('instructor');
  return doors.filter((d, i) => doors.indexOf(d) === i);
}

/**
 * Which door someone lands on.
 *
 * The most senior one they hold — an owner opening the portal wants the
 * centre, not their own next shift. A saved preference wins over that, so
 * Rahul (host AND instructor) can decide the desk board is his home.
 */
export function resolveDoor(auth = {}, preferred = null) {
  const allowed = doorsFor(auth);
  if (preferred && allowed.includes(preferred)) return preferred;
  return allowed[0];
}

const DOOR_KEY_PREFIX = 'ratio-door:';

export function readPreferredDoor(uid) {
  const v = read(`${DOOR_KEY_PREFIX}${uid || 'anon'}`);
  return DOORS.includes(v) ? v : null;
}
export function setPreferredDoor(uid, door) {
  if (!DOORS.includes(door)) return null;
  write(`${DOOR_KEY_PREFIX}${uid || 'anon'}`, door);
  return door;
}
