import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { watchCheckIns, watchWalkIns } from '../../lib/scheduler-data';
import { countsInRatio } from '../../lib/ratioCount';
import RatioBar from '../../components/newlook/RatioBar';
import { ratioOf, ratioHealth } from '../../lib/ratioShape';
import { Card, Lbl, Btn } from '../../components/newlook/ui';
import { fmtTime, todayISO, minutesOf } from '../../components/newlook/format';

/**
 * The host's door — a board, not a page.
 *
 * Rahul is standing at the desk with a parent in front of him. His question
 * is "what is true right now?" Not this week, not this period: the next
 * thirty minutes. So only today exists here, and nothing on screen is
 * something he cannot act on mid-shift.
 *
 * DARK ON PURPOSE. This is meant to sit on an always-on screen facing the
 * room for four hours. A white page glaring at the front desk all evening
 * is the wrong object, and dark makes it read as a board rather than a page
 * you are supposed to work inside.
 *
 * Every number is followed by the people it is made of. "16 students in" is
 * useless when a parent asks a question; the names are the answer.
 */
export default function HostHome() {
  const { activeCenterId } = useAuth();
  const today = todayISO();

  const [shifts, setShifts] = useState(null);
  const [checkIns, setCheckIns] = useState(null);
  const [walkIns, setWalkIns] = useState({});
  const [clock, setClock] = useState(() => new Date());

  // The desk display is left open. Re-tick so "on now" stays true.
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '==', today),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.status !== 'draft' && s.status !== 'cancelled')),
      () => setShifts([]),
    );
  }, [activeCenterId, today]);

  // Subscriptions are set up without touching state synchronously — a
  // setState in the body of an effect cascades an extra render, and the
  // lint rule that says so is right. If a subscription can't be built the
  // value simply stays null, and the ratio renders "—" rather than a zero
  // that looks like a real reading.
  useEffect(() => {
    if (!activeCenterId) return undefined;
    let unsub;
    try {
      unsub = watchCheckIns(activeCenterId, today, (entries) => setCheckIns(entries || {}));
    } catch (err) {
      console.warn('[host board] check-ins unavailable:', err?.message || err);
    }
    return () => unsub?.();
  }, [activeCenterId, today]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    let unsub;
    try {
      unsub = watchWalkIns(activeCenterId, today, (data) => setWalkIns(data || {}));
    } catch (err) {
      console.warn('[host board] walk-ins unavailable:', err?.message || err);
    }
    return () => unsub?.();
  }, [activeCenterId, today]);

  const nowMin = clock.getHours() * 60 + clock.getMinutes();

  /** Who is physically on the floor at this minute. */
  const onNow = useMemo(() => (shifts || []).filter(s => {
    const a = minutesOf(s.startTime);
    const b = minutesOf(s.endTime);
    return a != null && b != null && nowMin >= a && nowMin < b;
  }), [shifts, nowMin]);

  /**
   * Only people who count toward the ratio. Trainees and volunteers are on
   * the floor but never fill a ratio slot — that rule is settled and lives
   * in ratioCount.js, so it is read from there rather than re-guessed.
   */
  const ratioStaff = useMemo(() => onNow.filter(countsInRatio), [onNow]);

  const studentsIn = useMemo(() => {
    if (!checkIns) return null;
    return Object.values(checkIns).filter(e => (e?.status || e) === 'in').length;
  }, [checkIns]);

  const waiting = useMemo(() => {
    const rows = [];
    for (const [slot, list] of Object.entries(walkIns || {})) {
      if (!Array.isArray(list)) continue;
      for (const w of list) rows.push({ ...w, slot });
    }
    return rows;
  }, [walkIns]);

  const startingSoon = useMemo(() => (shifts || []).filter(s => {
    const a = minutesOf(s.startTime);
    return a != null && a > nowMin && a - nowMin <= 60;
  }).sort((a, b) => String(a.startTime).localeCompare(String(b.startTime))), [shifts, nowMin]);

  const ratio = ratioOf(ratioStaff.length, studentsIn);
  const health = ratioHealth(ratio);
  const ratioTone = health === 'ok' ? 'var(--nl-ok)'
                  : health === 'warn' ? 'var(--nl-warn)'
                  : health === 'over' ? 'var(--nl-brand)'
                  : 'var(--nl-muted)';

  return (
    <div className="nl-board -m-4 min-h-full p-5 md:-m-6 md:p-7 lg:-m-8"
      style={{ background: 'var(--nl-paper)', color: 'var(--nl-ink)' }}>

      {/* ── Ratio + clock ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <Lbl>Ratio right now</Lbl>
          <div className="mt-1.5 flex items-baseline gap-4">
            <span className="nl-display text-[56px] font-bold leading-none" style={{ color: ratioTone }}>
              {studentsIn === null ? '—' : ratio === null ? '—' : ratio === Infinity ? '!' : `1:${ratio.toFixed(1)}`}
            </span>
            <RatioBar instructors={ratioStaff.length} students={studentsIn} size={13} />
          </div>
          <div className="mt-2 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
            {ratioStaff.length} counting toward ratio
            {onNow.length !== ratioStaff.length && ` · ${onNow.length} on the floor`}
            {studentsIn !== null && ` · ${studentsIn} student${studentsIn === 1 ? '' : 's'} in`}
            {' · target 1:3.5'}
          </div>
        </div>
        <div className="text-right">
          <Lbl>Time</Lbl>
          <div className="nl-display text-[34px] font-semibold leading-none">
            {clock.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}
          </div>
          <div className="mt-1 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
            {clock.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
        </div>
      </div>

      {/* ── On the floor ────────────────────────────────────────── */}
      <div className="mt-7">
        <Lbl className="mb-2.5">On the floor</Lbl>
        {shifts === null ? (
          <div className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>Loading today…</div>
        ) : onNow.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>
            Nobody is on right now.
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
            {onNow.map(s => (
              <div key={s.id} className="rounded-xl border px-3 py-2.5"
                style={{ background: 'var(--nl-card)', borderColor: 'var(--nl-rule)' }}>
                <div className="truncate text-[13px] font-semibold">{s.userName || 'Unnamed'}</div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--nl-muted)' }}>
                  {fmtTime(s.startTime)}–{fmtTime(s.endTime)}
                  {s.subRole ? ` · ${s.subRole}` : ''}
                </div>
                {!countsInRatio(s) && (
                  <div className="mt-1 text-[10px] font-bold uppercase tracking-wide"
                    style={{ color: 'var(--nl-warn)' }}>not in ratio</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Waiting + next on ───────────────────────────────────── */}
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <Card>
          <Lbl>Waiting at the desk</Lbl>
          <div className="nl-display mt-1 text-[24px] font-semibold">
            {waiting.length === 0 ? 'Nobody' : `${waiting.length} walk-in${waiting.length === 1 ? '' : 's'}`}
          </div>
          {waiting.length > 0 && (
            <div className="mt-2 space-y-1 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
              {waiting.slice(0, 5).map((w, i) => (
                <div key={w.id || i}>
                  {w.name}{w.isAssessment ? ' · assessment' : ''}
                </div>
              ))}
            </div>
          )}
          <Btn to="/scheduler-creation" variant="ghost" size="sm" className="mt-3">
            Open the room sheet
          </Btn>
        </Card>

        <Card>
          <Lbl>Starting within the hour</Lbl>
          <div className="nl-display mt-1 text-[24px] font-semibold">
            {startingSoon.length === 0 ? 'Nobody' : `${startingSoon.length} coming on`}
          </div>
          {startingSoon.length > 0 && (
            <div className="mt-2 space-y-1 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
              {startingSoon.slice(0, 5).map(s => (
                <div key={s.id}>{s.userName} · {fmtTime(s.startTime)}</div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Only shown when it's actually true — an alert that is always
          present is wallpaper, and this one has to mean something. */}
      {ratio !== null && ratio !== Infinity && health === 'over' && (
        <div className="mt-5 rounded-xl border px-4 py-3 text-[13.5px] font-semibold"
          style={{ borderColor: 'var(--nl-brand)', background: 'var(--nl-brandw)', color: 'var(--nl-brand)' }}>
          Past the 1:4 floor — {studentsIn} students to {ratioStaff.length} on ratio.
        </div>
      )}
      {ratio === Infinity && (
        <div className="mt-5 rounded-xl border px-4 py-3 text-[13.5px] font-semibold"
          style={{ borderColor: 'var(--nl-brand)', background: 'var(--nl-brandw)', color: 'var(--nl-brand)' }}>
          {studentsIn} students checked in and nobody on the floor counting toward ratio.
        </div>
      )}
    </div>
  );
}
