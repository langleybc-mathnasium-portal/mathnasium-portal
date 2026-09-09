import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { Mail, ArrowRight, Megaphone } from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { Card, Pill, Btn, Lbl, AllClear, Loading } from '../../components/newlook/ui';
import { fmtTime, fmtDay, todayISO, minutesOf } from '../../components/newlook/format';

/**
 * The instructor's door.
 *
 * Her question is "am I on today, and does anyone need anything from me?"
 * She is not browsing — she is standing outside about to walk in, and she
 * wants to close the app.
 *
 * SO: the thing to DO sits above the thing to KNOW. Today's shift is the
 * headline, but the only button on the page belongs to whatever Ratio needs
 * from her. When that card is absent, she is done.
 *
 * Every figure here is read from Firestore. Nothing is illustrative.
 */
export default function InstructorHome() {
  const { profile, activeCenterId, mySubRoles, canTakeShifts } = useAuth();
  const [shifts, setShifts] = useState(null);        // null = still loading
  // Stamped with the date it belongs to, so "is this stale?" is derived
  // rather than reset from inside an effect — the same shape
  // TodaysSnapshot uses for exactly this reason.
  const [dayRoster, setDayRoster] = useState({ date: null, rows: null });
  const [openShifts, setOpenShifts] = useState([]);
  const [announcement, setAnnouncement] = useState(null);
  const today = todayISO();

  // Their own shifts from today forward.
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

  const next = useMemo(() => {
    if (!shifts) return null;
    return shifts
      .filter(s => s.date >= today && s.status !== 'draft')
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime).localeCompare(String(b.startTime)))[0] || null;
  }, [shifts, today]);

  // Everyone rostered on the same day, so she can see how busy the floor
  // will be before she walks in. Scoped to that one date.
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

  // What Ratio needs FROM her. Right now that's one thing: a sign-out the
  // centre has asked her to confirm and she hasn't. The confirm itself
  // happens through the emailed link (single-use token), so this points at
  // the email rather than pretending to be a second way in.
  const pending = useMemo(() => (shifts || []).filter(s =>
    s.signOutRequestSentAt && !s.signOutConfirmedTime), [shifts]);

  const eligibleOpen = useMemo(() => {
    const mine = mySubRoles || [];
    if (mine.length === 0) return [];
    return openShifts.filter(s => !s.subRole || mine.includes(s.subRole));
  }, [openShifts, mySubRoles]);

  if (shifts === null) return <Loading label="Getting your shifts…" />;

  const isToday = next?.date === today;
  // Only trust the roster if it's for the shift we're showing.
  const dayShifts = dayRoster.date === next?.date ? dayRoster.rows : null;
  const onFloor = (dayShifts || []).filter(s => s.status !== 'draft').length;
  const first = (profile?.displayName || '').split(' ')[0] || 'there';

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pb-4">
      <h1 className="nl-display text-[24px] font-semibold">{greeting()}, {first}</h1>

      {/* ── The shift ───────────────────────────────────────────── */}
      {next ? (
        <div className="rounded-2xl p-5 text-white" style={{ background: 'var(--nl-brand)' }}>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-80">
            {isToday ? "You're on today" : `Next shift · ${fmtDay(next.date)}`}
          </div>
          <div className="nl-display mt-1 text-[30px] font-bold leading-none">
            {fmtTime(next.startTime)} – {fmtTime(next.endTime)}
          </div>
          <div className="mt-1.5 text-[13.5px] opacity-90">
            {[next.subRole, next.instructorType].filter(Boolean).join(' · ') || 'Floor'}
            {isToday && startsIn(next.startTime)}
          </div>

          {dayShifts && onFloor > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3"
              style={{ borderColor: 'rgba(255,255,255,.3)' }}>
              <span className="text-[12.5px] opacity-90">
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
        <AllClear title="No shifts booked" note="Nothing scheduled for you yet. Your availability is how you get on the sheet." />
      )}

      {/* ── The only thing with a button ────────────────────────── */}
      {pending.length > 0 && (
        <Card tone="warn" className="!border-[1.5px]">
          <Pill tone="warn"><Mail size={12} /> Needs you</Pill>
          {pending.slice(0, 3).map(s => (
            <p key={s.id} className="mt-2 text-[13.5px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
              <b>{fmtDay(s.date)}</b> — you signed in but never signed out.
              We emailed you a link to confirm you finished at {fmtTime(s.endTime)}.
            </p>
          ))}
          <p className="mt-2 text-[12px]" style={{ color: 'var(--nl-muted)' }}>
            Check your email — the link confirms it in one tap. Left at a different
            time? Tell the centre instead.
          </p>
        </Card>
      )}

      {/* ── Coming up ───────────────────────────────────────────── */}
      {shifts.filter(s => s.date >= today && s.status !== 'draft').length > 1 && (
        <div>
          <Lbl className="mb-2">Coming up</Lbl>
          <Card className="!p-0">
            {shifts
              .filter(s => s.date >= today && s.status !== 'draft' && s.id !== next?.id)
              .sort((a, b) => a.date.localeCompare(b.date))
              .slice(0, 4)
              .map((s, i) => (
                <div key={s.id}
                  className={`flex items-center justify-between gap-3 px-4 py-3 ${i > 0 ? 'border-t' : ''}`}
                  style={{ borderColor: 'var(--nl-rule)' }}>
                  <span>
                    <span className="block text-[13.5px] font-semibold">{fmtDay(s.date)}</span>
                    <span className="block text-[12px]" style={{ color: 'var(--nl-muted)' }}>
                      {[s.subRole, s.instructorType].filter(Boolean).join(' · ') || 'Floor'}
                    </span>
                  </span>
                  <span className="text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
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
          <div className="flex items-center justify-between gap-3">
            <div>
              <b className="text-[14px]">
                {eligibleOpen.length} open {eligibleOpen.length === 1 ? 'shift' : 'shifts'}
              </b>
              <div className="mt-0.5 text-[12px]" style={{ color: 'var(--nl-muted)' }}>
                You can cover {eligibleOpen.length === 1 ? 'it' : 'all of them'}
              </div>
            </div>
            <Btn to="/shift-board" variant="ghost" size="sm">Look</Btn>
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
          <b className="mt-1.5 block text-[14px]">{announcement.title}</b>
          <p className="mt-1 line-clamp-2 text-[13px]" style={{ color: 'var(--nl-ink2)' }}>
            {announcement.text}
          </p>
          <Btn to="/announcements" variant="quiet" size="sm" className="mt-3">Read it</Btn>
        </Card>
      )}
    </div>
  );
}

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}

/** " · starts in 2h 15m", or nothing once it's underway. */
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
