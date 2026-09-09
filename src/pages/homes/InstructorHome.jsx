import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { Mail, ArrowRight, Megaphone, CalendarDays, MoveRight } from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { setNewLook } from '../../lib/newLook';
import { watchInstructorAssignments } from '../../lib/scheduler-data';
import {
  blocksForPerson, blockAt, nextSwitch, hasSwitch, sideLabel,
} from '../../lib/sideAssignments';
import { Card, Pill, Btn, Lbl, AllClear, Loading } from '../../components/newlook/ui';
import { fmtTime, fmtDay, todayISO, minutesOf } from '../../components/newlook/format';

/**
 * The floor-staff home — built for a phone held in one hand.
 *
 * Her question is "am I on today, and does anyone need anything from me?"
 * She is standing outside about to walk in, and she wants to close the app.
 *
 * SO: the thing to DO sits above the thing to KNOW. Today's shift is the
 * headline, but the only button on the page belongs to whatever Ratio needs
 * from her. When that card is absent, she is done.
 *
 * EVERY FIGURE IS A DIRECT READ of her own shifts, the open-shift board, or
 * the announcements feed. That is deliberate, and it is why this page
 * survived when the owner, director and host boards did not: those needed
 * live Radius data and cross-collection maths this app cannot yet do
 * quickly or completely, so their numbers could not be trusted. Nothing
 * here is derived, estimated, or illustrative.
 *
 * MOBILE RULES FOLLOWED THROUGHOUT
 *   - one column, always; nothing side-by-side that could squeeze
 *   - every tappable thing is at least 44px tall
 *   - buttons go full width on a phone, shrink to fit from `sm` up
 *   - the page ends with clearance for the bottom tab bar
 */
export default function InstructorHome() {
  const { profile, activeCenterId, mySubRoles, canTakeShifts } = useAuth();
  const [shifts, setShifts] = useState(null);        // null = still loading
  const [dayRoster, setDayRoster] = useState({ date: null, rows: null });
  const [openShifts, setOpenShifts] = useState([]);
  const [announcement, setAnnouncement] = useState(null);
  // { date, map } — stamped so staleness is derived, never reset in an effect.
  const [sides, setSides] = useState({ date: null, map: null });
  const [roster, setRoster] = useState(null);
  const today = todayISO();

  useEffect(() => {
    if (!profile?.uid || !activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('userId', '==', profile.uid),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setShifts([]),
    );
  }, [profile?.uid, activeCenterId]);

  const upcoming = useMemo(() => (shifts || [])
    .filter(s => s.date >= today && s.status !== 'draft' && s.status !== 'cancelled')
    .sort((a, b) => a.date.localeCompare(b.date)
      || String(a.startTime).localeCompare(String(b.startTime))), [shifts, today]);

  const next = upcoming[0] || null;

  // Everyone rostered the same day, so she knows how busy the floor will be
  // before she walks in. Stamped with its date so staleness is derived
  // rather than reset from inside an effect.
  useEffect(() => {
    const date = next?.date;
    if (!activeCenterId || !date) return undefined;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '==', date),
      ),
      snap => setDayRoster({ date, rows: snap.docs.map(d => ({ id: d.id, ...d.data() })) }),
      () => setDayRoster({ date, rows: [] }),
    );
  }, [activeCenterId, next?.date]);

  // Which side of the room, per half hour. Neeru sets this in the Student
  // Scheduler before the day; until now the only copies were her screen and
  // the printed sheet, so instructors arrived asking out loud.
  useEffect(() => {
    const date = next?.date;
    if (!activeCenterId || !date) return undefined;
    let unsub;
    try {
      unsub = watchInstructorAssignments(activeCenterId, date,
        (map) => setSides({ date, map: map || {} }));
    } catch (err) {
      console.warn('[home] side assignments unavailable:', err?.message || err);
    }
    return () => unsub?.();
  }, [activeCenterId, next?.date]);

  useEffect(() => {
    if (!activeCenterId || !canTakeShifts) return undefined;
    return onSnapshot(
      query(
        collection(db, 'openShifts'),
        where('centerId', '==', activeCenterId),
        orderBy('date', 'asc'),
      ),
      snap => setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.date >= today && !s.claimedBy)),
      () => setOpenShifts([]),
    );
  }, [activeCenterId, canTakeShifts, today]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'announcements'),
        where('centerId', '==', activeCenterId),
        orderBy('date', 'desc'),
        limit(5),
      ),
      snap => {
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        rows.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
        setAnnouncement(rows[0] || null);
      },
      () => setAnnouncement(null),
    );
  }, [activeCenterId]);

  // What Ratio needs FROM her. The confirm itself happens through the
  // emailed single-use link, so this points at the email rather than
  // pretending to be a second way in.
  const pending = useMemo(() => (shifts || []).filter(s =>
    s.signOutRequestSentAt && !s.signOutConfirmedTime), [shifts]);

  const eligibleOpen = useMemo(() => {
    const mine = mySubRoles || [];
    if (mine.length === 0) return [];
    return openShifts.filter(s => !s.subRole || mine.includes(s.subRole));
  }, [openShifts, mySubRoles]);

  const sideMap = sides.date === next?.date ? sides.map : null;
  const myName = profile?.displayName || '';

  // Exact display name matches every current member of staff — checked
  // against every live assignment document. The roster is only needed to
  // disambiguate a bare first name ("Bri", "Sofie"), which the sheet
  // occasionally carries, so it is fetched ONLY when the exact pass finds
  // nothing. That keeps 50-odd user reads off the common path.
  const exactBlocks = useMemo(
    () => blocksForPerson(sideMap, myName, []), [sideMap, myName]);
  const needRoster = !!sideMap && Object.keys(sideMap).length > 0
    && exactBlocks.length === 0 && roster === null;

  useEffect(() => {
    if (!needRoster || !activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setRoster(snap.docs.map(d => d.data()?.displayName).filter(Boolean)),
      () => setRoster([]),
    );
  }, [needRoster, activeCenterId]);

  const blocks = useMemo(
    () => (exactBlocks.length > 0 ? exactBlocks : blocksForPerson(sideMap, myName, roster || [])),
    [exactBlocks, sideMap, myName, roster]);

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const currentBlock = isTodayDate(next?.date, today) ? blockAt(blocks, nowMin) : null;
  const upNext = isTodayDate(next?.date, today) ? nextSwitch(blocks, nowMin) : null;

  const dayShifts = dayRoster.date === next?.date ? dayRoster.rows : null;
  const onFloor = (dayShifts || []).filter(s => s.status !== 'draft').length;
  const first = (profile?.displayName || '').split(' ')[0] || 'there';
  const isToday = next?.date === today;

  return (
    // pb-28 clears the bottom tab bar on phones; it drops away at lg, where
    // the bar isn't rendered and the sidebar is back.
    <div className="nl mx-auto w-full max-w-2xl space-y-3.5 pb-28 lg:pb-4">

      <div className="flex items-start justify-between gap-3">
        <h1 className="nl-display text-[26px] font-semibold leading-tight">
          {greeting()}, {first}
        </h1>
        <button
          type="button"
          onClick={() => { setNewLook(profile?.uid, false); window.location.reload(); }}
          className="-mr-1 mt-1 shrink-0 rounded-lg px-2 py-1.5 text-[11.5px] font-semibold underline underline-offset-2"
          style={{ color: 'var(--nl-muted)' }}>
          Classic view
        </button>
      </div>

      {shifts === null ? (
        <Loading label="Getting your shifts…" />
      ) : next ? (
        <div className="rounded-2xl p-5" style={{ background: 'var(--nl-brand)', color: '#fff' }}>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-80">
            {isToday ? "You're on today" : `Next shift · ${fmtDay(next.date)}`}
          </div>
          {/* The biggest thing on the page, because it's the answer. */}
          <div className="nl-display mt-1.5 text-[32px] font-bold leading-none sm:text-[36px]">
            {fmtTime(next.startTime)} – {fmtTime(next.endTime)}
          </div>
          <div className="mt-2 text-[14px] opacity-90">
            {[next.subRole, next.instructorType].filter(Boolean).join(' · ') || 'Floor'}
            {isToday && startsIn(next.startTime)}
          </div>

          {dayShifts && onFloor > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3"
              style={{ borderColor: 'rgba(255,255,255,.3)' }}>
              <span className="text-[13px] opacity-90">
                {onFloor} {onFloor === 1 ? 'person' : 'people'} rostered that day
              </span>
              <Btn to="/schedule" size="sm" variant="ghost"
                className="!border-white/60 !text-white">
                Full schedule <ArrowRight size={13} />
              </Btn>
            </div>
          )}
        </div>
      ) : (
        <AllClear title="No shifts booked"
          note="Nothing scheduled for you yet. Submitting your availability is how you get on the sheet." />
      )}

      {/* ── Which side, and when you move ───────────────────────── */}
      {next && blocks.length > 0 && (
        <div>
          <Lbl className="mb-1.5">
            {isTodayDate(next.date, today) ? 'Your day' : `Your day · ${fmtDay(next.date)}`}
          </Lbl>
          <Card className="!p-0 overflow-hidden">
            {blocks.map((b, i) => {
              const live = currentBlock && b.startMin === currentBlock.startMin;
              return (
                <div key={`${b.side}-${b.start}`}
                  className={`flex items-center gap-3 px-4 py-3.5 ${i > 0 ? 'border-t' : ''}`}
                  style={{
                    borderColor: 'var(--nl-rule)',
                    background: live ? 'var(--nl-raised)' : undefined,
                  }}>
                  {/* A colour stripe rather than a dot: it survives being
                      glanced at, and matches the HS/EM colours on the sheet
                      Neeru prints, so the two read as the same thing. */}
                  <span className="h-9 w-1.5 shrink-0 rounded-full"
                    style={{ background: sideColour(b.side) }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold tabular-nums">
                      {fmtTime(b.start)} – {fmtTime(b.end)}
                    </span>
                    <span className="block text-[13px]" style={{ color: 'var(--nl-muted)' }}>
                      {sideLabel(b.side)}
                    </span>
                  </span>
                  {live && <Pill tone="brand">Now</Pill>}
                </div>
              );
            })}
          </Card>

          {/* The second half of the question, said in words. */}
          {upNext && (
            <p className="mt-2 flex items-start gap-1.5 px-1 text-[13px] leading-relaxed"
              style={{ color: 'var(--nl-ink2)' }}>
              <MoveRight size={15} className="mt-0.5 shrink-0" style={{ color: sideColour(upNext.side) }} />
              <span>You move to <b>{sideLabel(upNext.side)}</b> at <b>{fmtTime(upNext.start)}</b>.</span>
            </p>
          )}
          {!upNext && hasSwitch(blocks) && isTodayDate(next.date, today) && currentBlock && (
            <p className="mt-2 px-1 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
              No more moves today — you finish on {sideLabel(currentBlock.side)}.
            </p>
          )}
          {!hasSwitch(blocks) && (
            <p className="mt-2 px-1 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
              You&apos;re on {sideLabel(blocks[0].side)} the whole shift.
            </p>
          )}
        </div>
      )}

      {/* Sides not posted yet. Only said on the day itself — for a shift
          next week it is simply too early, and a permanent "not posted"
          note would train people to ignore this whole section. */}
      {next && isTodayDate(next.date, today) && sideMap && blocks.length === 0 && (
        <p className="px-1 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
          Sides aren&apos;t posted for today yet. Ask whoever&apos;s running the floor.
        </p>
      )}

      {/* ── The only thing with a button ────────────────────────── */}
      {pending.length > 0 && (
        <Card tone="warn" className="!border-[1.5px]">
          <Pill tone="warn"><Mail size={12} /> Needs you</Pill>
          {pending.slice(0, 3).map(s => (
            <p key={s.id} className="mt-2.5 text-[14px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
              <b>{fmtDay(s.date)}</b> — you signed in but never signed out.
              We emailed you a link to confirm you finished at {fmtTime(s.endTime)}.
            </p>
          ))}
          <p className="mt-2.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--nl-muted)' }}>
            Check your email — the link confirms it in one tap. Left at a
            different time? Tell the centre instead.
          </p>
        </Card>
      )}

      {/* ── Coming up ───────────────────────────────────────────── */}
      {upcoming.length > 1 && (
        <div>
          <Lbl className="mb-1.5">Coming up</Lbl>
          <Card className="!p-0">
            {upcoming.slice(1, 5).map((s, i) => (
              <div key={s.id}
                className={`flex items-center justify-between gap-3 px-4 py-3.5 ${i > 0 ? 'border-t' : ''}`}
                style={{ borderColor: 'var(--nl-rule)' }}>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold">{fmtDay(s.date)}</span>
                  <span className="block truncate text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
                    {[s.subRole, s.instructorType].filter(Boolean).join(' · ') || 'Floor'}
                  </span>
                </span>
                <span className="shrink-0 text-[13px] tabular-nums" style={{ color: 'var(--nl-muted)' }}>
                  {fmtTime(s.startTime)} – {fmtTime(s.endTime)}
                </span>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── Open shifts ─────────────────────────────────────────── */}
      {canTakeShifts && eligibleOpen.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <b className="block text-[14.5px]">
                {eligibleOpen.length} open {eligibleOpen.length === 1 ? 'shift' : 'shifts'}
              </b>
              <span className="mt-0.5 block text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
                You can cover {eligibleOpen.length === 1 ? 'it' : 'all of them'}
              </span>
            </div>
            <Btn to="/shift-board" variant="ghost" size="sm"
              className="w-full justify-center sm:w-auto">
              <CalendarDays size={14} /> Look
            </Btn>
          </div>
        </Card>
      )}

      {/* ── Announcement ────────────────────────────────────────── */}
      {announcement && (
        <Card>
          <div className="flex items-center gap-2">
            <Megaphone size={14} style={{ color: 'var(--nl-brand)' }} />
            <Lbl>Latest from the centre</Lbl>
          </div>
          <b className="mt-1.5 block text-[14.5px] leading-snug">{announcement.title}</b>
          <p className="mt-1 line-clamp-3 text-[13.5px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
            {announcement.text}
          </p>
          <Btn to="/announcements" variant="quiet" size="sm"
            className="mt-3 w-full justify-center sm:w-auto">Read it</Btn>
        </Card>
      )}
    </div>
  );
}

/** Same two colours as the printed sheet, so they read as the same thing. */
function sideColour(side) {
  return side === 'HS' ? '#1e3a8a' : '#065f46';   // blue-900 / emerald-800
}

/** Is this ISO date today? Compared as strings — both are centre-local. */
function isTodayDate(date, today) {
  return !!date && date === today;
}

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}

/** " · starts in 2h 15m", or " · underway" once it has begun. */
function startsIn(startTime) {
  const start = minutesOf(startTime);
  if (start == null) return '';
  const now = new Date();
  const mins = start - (now.getHours() * 60 + now.getMinutes());
  if (mins <= 0) return ' · underway';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return ` · starts in ${h > 0 ? `${h}h ` : ''}${m}m`;
}
