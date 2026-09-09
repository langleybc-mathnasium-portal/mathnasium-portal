/**
 * newLook.js — the opt-in phone-first home for floor staff.
 *
 * WHAT THIS IS NOW
 *   A single alternative Home for the people who work shifts: instructors,
 *   leads, trainees and volunteers. Their question is "am I on today, and
 *   does anyone need anything from me?", they are asking it on a phone, and
 *   the classic Home answers it through a sidebar built for an owner's
 *   eighteen links behind a hamburger menu.
 *
 * WHAT IT USED TO BE, AND WHY IT ISN'T
 *   It started as four doors — owner, director, host, instructor. The
 *   owner, director and host boards were removed after review: their
 *   figures depend on live Radius reads and cross-collection queries this
 *   app cannot yet do quickly or completely, so the numbers they showed
 *   were not trustworthy. A dashboard that is confidently wrong is worse
 *   than no dashboard, and leadership already has pages whose numbers are
 *   known-good. Only the instructor door survives, because everything on
 *   it is a direct read of that person's own shifts.
 *
 *   If the Radius API in Ratio_Radius_API_Request_Brief.docx is ever
 *   approved, the other three become worth revisiting — with real data
 *   behind them.
 *
 * OFF BY DEFAULT, PER PERSON
 *   Nobody meets a redesigned portal because a deploy landed. The
 *   preference is keyed by uid, so signing out of one account and into
 *   another on the same laptop does not carry it across.
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

/** Is it on for this person? Off unless they turned it on. */
export function isNewLookOn(uid) {
  return read(newLookKey(uid)) === 'on';
}

/** Turn it on or off for this person. Returns the new state. */
export function setNewLook(uid, on) {
  write(newLookKey(uid), on ? 'on' : 'off');
  return !!on;
}

/**
 * Who this is for: people whose job is working shifts.
 *
 * `isOwnerLike` already means owner / admin-assistant / super-admin /
 * director, and plain `admin` runs centre operations — all of them open the
 * portal to run the centre, not to find out when they are next in, and all
 * of them have pages whose numbers are known-good. Everyone else is floor
 * staff: instructors, leads, managers, trainees, volunteers.
 *
 * Read as "not leadership" rather than a list of job titles, so a custom
 * centre role invented in Manage Roles lands on the right side without
 * anyone editing this file.
 */
export function canUseNewLook(auth = {}) {
  const { isOwnerLike, isAdmin, isSuperAdmin, isOwner, isDirector, isAdminAssistant } = auth;
  const leadership = isOwnerLike
    || isSuperAdmin || isOwner || isDirector || isAdminAssistant || isAdmin;
  return !leadership;
}

/**
 * Should this person actually be shown it right now?
 * Both eligible AND opted in — the check every caller wants.
 */
export function newLookActive(auth = {}) {
  return canUseNewLook(auth) && isNewLookOn(auth?.profile?.uid);
}
