/**
 * centreDate.js — "what day is it at the centre?"
 *
 * WHY THIS EXISTS
 *   Vercel Lambdas run in UTC. Vancouver is UTC−7 (−8 in winter), so from
 *   about 5pm local onward the server's own calendar date is already
 *   TOMORROW. Anything that reached for `new Date().toISOString().slice(0,10)`
 *   as "today" was therefore a day ahead every single evening — the exact
 *   hours the centre is busiest.
 *
 *   The damage wasn't cosmetic. `_tools.js` filtered open shifts with
 *   `date >= today`, so after 5pm tonight's open shifts dropped out of the
 *   assistant's answers entirely; and the assistant was told, in its system
 *   prompt, that it was the following day.
 *
 *   `api/cron/send-shift-reminders.js` already did this properly. This file
 *   is that logic lifted out so there is one implementation instead of a
 *   correct one and several wrong ones. Files under `_lib/` are not routed,
 *   so this costs nothing against the 12-function cap.
 *
 * ALL CENTRE DATES ARE WALL-CLOCK STRINGS
 *   Shift docs store `date` as a plain "YYYY-MM-DD" in centre-local terms.
 *   Comparing those against a UTC-derived string is the bug; compare them
 *   against these instead.
 */

// Overridable so a centre in another zone can be added without a code change.
export const CENTER_TZ = process.env.CENTER_TZ || 'America/Vancouver';

/**
 * The centre-local calendar date ("YYYY-MM-DD") for a given instant.
 * Intl does the DST work for the specific instant, so this stays correct
 * across the March and November transitions.
 */
export function centreYMD(date = new Date(), timeZone = CENTER_TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Today at the centre, as "YYYY-MM-DD". */
export function centreToday(timeZone = CENTER_TZ) {
  return centreYMD(new Date(), timeZone);
}

/**
 * Today at the centre, shifted by whole days — `centreOffsetYMD(-30)` is
 * thirty centre-days ago.
 *
 * Steps by 24h from the current instant and then reads the local date, which
 * is what the reminder cron does. Across a DST boundary the instant lands an
 * hour off, but the calendar date it reads is still the intended one.
 */
export function centreOffsetYMD(offsetDays, timeZone = CENTER_TZ) {
  return centreYMD(new Date(Date.now() + offsetDays * 86400000), timeZone);
}
