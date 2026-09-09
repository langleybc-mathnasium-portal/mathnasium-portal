import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { AlertTriangle, UserCheck, Wallet, CalendarRange } from 'lucide-react';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { resolveWeekdayModel, budgetForDates, datesBetween } from '../../lib/budgetBuckets';
import { availabilityConflict, describeConflict } from '../../lib/availabilityFit';
import { countsInRatio } from '../../lib/ratioCount';
import RatioBar from '../../components/newlook/RatioBar';
import { Card, Lbl, Btn, Pill, Meter, AllClear, Loading } from '../../components/newlook/ui';
import { fmtTime, fmtDay, todayISO, asDate } from '../../components/newlook/format';

/**
 * The director's door — a list that ends.
 *
 * Vin's question is "what is going to go wrong, and what do I have to fix?"
 * He does not need a dashboard; he needs to reach the bottom of something.
 *
 * The exceptions the portal already computes are scattered across Manage
 * Schedule, Manage Payroll and the Staffing Board, so there is currently no
 * way to know you are done. Here they are one list, every row carries one
 * verb, and the heading counts them down.
 *
 * Nothing here is a new rule. Availability clashes come from
 * availabilityFit.js, the budget from budgetBuckets.js, ratio membership
 * from ratioCount.js — the same libraries the classic pages read.
 */
export default function DirectorHome() {
  const { activeCenterId, centerConfig } = useAuth();
  const today = todayISO();

  const week = useMemo(() => weekOf(today), [today]);
  const [shifts, setShifts] = useState(null);
  const [availability, setAvailability] = useState(null);
  const [openShifts, setOpenShifts] = useState([]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', week[0]),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.date <= week[6] && s.status !== 'cancelled')),
      () => setShifts([]),
    );
  }, [activeCenterId, week]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'availability'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', week[0]),
      ),
      snap => setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(a => a.date <= week[6])),
      () => setAvailability([]),
    );
  }, [activeCenterId, week]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'openShifts'), where('centerId', '==', activeCenterId)),
      snap => setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.date >= today && !s.claimedBy)),
      () => setOpenShifts([]),
    );
  }, [activeCenterId, today]);

  // ── Budget for the week on screen ────────────────────────────
  const budget = useMemo(() => {
    const model = resolveWeekdayModel(centerConfig);
    const holidays = new Set((centerConfig?.holidays || []).map(h => h?.date || h));
    return budgetForDates(datesBetween(week[0], week[6]), model, {
      isClosed: (d) => holidays.has(d),
    });
  }, [centerConfig, week]);

  const scheduled = useMemo(() => {
    if (!shifts) return 0;
    return Math.round(shifts.reduce((n, s) => n + hoursOf(s), 0) * 10) / 10;
  }, [shifts]);

  // ── The list ─────────────────────────────────────────────────
  const availClashes = useMemo(() => {
    if (!shifts || !availability) return [];
    const out = [];
    const byPersonDay = new Map();
    for (const s of shifts) {
      if (s.status === 'draft') continue;
      const k = `${s.userId}|${s.date}`;
      byPersonDay.set(k, [...(byPersonDay.get(k) || []), s]);
    }
    for (const [k, list] of byPersonDay) {
      const [userId, date] = k.split('|');
      // ALL of that person's rows for the day, not the first one.
      // `availabilityWindows` takes a list and merges it: somebody who
      // submits 10–2 and 2–6 is free 10–6 continuously, and judging one row
      // in isolation reports a 10–6 shift as a conflict at the seam.
      // Passing a single document also threw outright — the function
      // iterates its argument.
      const av = availability.filter(a => a.userId === userId && a.date === date);
      if (av.length === 0) continue;           // nothing submitted — never flagged
      const clash = availabilityConflict(list, av);
      if (clash) out.push({ ...clash, date, name: list[0]?.userName, shift: list[0] });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }, [shifts, availability]);

  const selfConfirmed = useMemo(() => (shifts || []).filter(s =>
    s.signOutConfirmedBy === 'instructor' && !s.payrollResolved), [shifts]);

  const awaitingConfirm = useMemo(() => (shifts || []).filter(s =>
    s.signOutRequestSentAt && !s.signOutConfirmedTime), [shifts]);

  const tasks = [
    openShifts.length > 0 && {
      key: 'open', tone: 'warn', icon: CalendarRange,
      title: `${openShifts.length} open ${openShifts.length === 1 ? 'shift' : 'shifts'} nobody has taken`,
      sub: openShifts.slice(0, 2).map(s => `${fmtDay(s.date, { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(s.startTime)}`).join(' · '),
      to: '/shift-board', verb: 'Fill',
    },
    availClashes.length > 0 && {
      key: 'avail', tone: 'warn', icon: AlertTriangle,
      title: `${availClashes.length} shift${availClashes.length === 1 ? '' : 's'} outside submitted availability`,
      // describeConflict takes a FIT, not the wrapper availabilityConflict
      // returns. The worst offender of the day is the one worth naming.
      sub: `${availClashes[0].name} · ${fmtDay(availClashes[0].date, { weekday: 'short', month: 'short', day: 'numeric' })} — ${describeConflict(availClashes[0].worst?.fit) || 'outside their submitted hours'}`,
      to: '/admin?tab=spreadsheet', verb: 'Look',
    },
    selfConfirmed.length > 0 && {
      key: 'self', tone: 'note', icon: UserCheck,
      title: `${selfConfirmed.length} sign-out${selfConfirmed.length === 1 ? '' : 's'} staff confirmed themselves`,
      sub: 'Stated, not clocked — worth a look before payroll closes.',
      to: '/admin?tab=payroll', verb: 'Review',
    },
    awaitingConfirm.length > 0 && {
      key: 'await', tone: 'flat', icon: UserCheck,
      title: `${awaitingConfirm.length} waiting on staff to confirm a sign-out`,
      sub: 'Emailed. Nothing for you to do unless they go quiet.',
      to: '/admin?tab=payroll', verb: 'Open',
    },
  ].filter(Boolean);

  if (shifts === null) return <Loading label="Reading this week…" />;

  const overBudget = scheduled > budget.total;

  return (
    <div className="space-y-5 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="nl-display text-[26px] font-semibold">This week</h1>
          <p className="mt-0.5 text-[13.5px]" style={{ color: 'var(--nl-muted)' }}>
            {fmtDay(week[0], { month: 'long', day: 'numeric' })} – {fmtDay(week[6], { month: 'long', day: 'numeric' })}
          </p>
        </div>

        {/* The constraint on every decision on this page belongs ON this
            page — small, in the corner, always there. */}
        <div className="min-w-[210px]">
          <div className="mb-1.5 flex items-center justify-between text-[11.5px] font-bold">
            <span style={{ color: 'var(--nl-muted)' }}>
              <Wallet size={11} className="mr-1 inline" />HOURS VS BUDGET
            </span>
            <span style={{ color: overBudget ? 'var(--nl-warn)' : 'var(--nl-ok)' }}>
              {scheduled} / {budget.total}
            </span>
          </div>
          <Meter value={scheduled} max={budget.total}
            tone={overBudget ? 'var(--nl-warn)' : 'var(--nl-ok)'} />
          <div className="mt-1.5 text-[11px]" style={{ color: 'var(--nl-muted)' }}>
            {budget.closedDays > 0
              ? `${budget.closedDays} closed day${budget.closedDays === 1 ? '' : 's'} excluded`
              : `${budget.openDays} open days`}
          </div>
        </div>
      </div>

      {/* ── Needs you ───────────────────────────────────────────── */}
      <div>
        <div className="mb-2 flex items-baseline gap-3">
          <h2 className="nl-display text-[18px] font-semibold">Needs you</h2>
          {tasks.length > 0 && (
            <span className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>
              {tasks.length} {tasks.length === 1 ? 'thing' : 'things'}. Then the week is clean.
            </span>
          )}
        </div>

        {tasks.length === 0 ? (
          <AllClear title="Nothing needs you"
            note="No open shifts, no availability clashes, no unreviewed sign-outs." />
        ) : (
          <Card className="!p-0">
            {tasks.map((t, i) => (
              <div key={t.key}
                className={`flex flex-wrap items-start gap-3 px-4 py-3.5 ${i > 0 ? 'border-t' : ''}`}
                style={{ borderColor: 'var(--nl-rule)' }}>
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                  style={{ background: t.tone === 'note' ? 'var(--nl-note)'
                    : t.tone === 'warn' ? 'var(--nl-warn)' : 'var(--nl-muted)' }} />
                <span className="min-w-0 flex-1">
                  <b className="block text-[14px]">{t.title}</b>
                  <span className="block text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>{t.sub}</span>
                </span>
                <Btn to={t.to} variant="ghost" size="sm">{t.verb}</Btn>
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* ── Cover, day by day ───────────────────────────────────── */}
      <div>
        <Lbl className="mb-2">Cover, day by day</Lbl>
        <Card className="!p-0 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr>
                {week.map(d => (
                  <th key={d} className="px-2 py-2.5 text-center text-[10px] font-bold uppercase tracking-[0.1em]"
                    style={{ color: 'var(--nl-muted)', borderBottom: '1px solid var(--nl-rule)' }}>
                    {asDate(d).toLocaleDateString('en-CA', { weekday: 'short' })}
                    <div className="mt-0.5 font-semibold tracking-normal"
                      style={{ color: d === today ? 'var(--nl-brand)' : 'var(--nl-muted)' }}>
                      {asDate(d).getDate()}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {week.map(d => {
                  const day = (shifts || []).filter(s => s.date === d && s.status !== 'draft');
                  const onRatio = day.filter(countsInRatio).length;
                  return (
                    <td key={d} className="px-2 py-3 text-center align-top">
                      <div className="nl-display text-[19px] font-semibold"
                        style={{ color: day.length === 0 ? 'var(--nl-muted)' : 'var(--nl-ink)' }}>
                        {day.length || '—'}
                      </div>
                      <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--nl-muted)' }}>
                        {onRatio > 0 ? `${onRatio} on ratio` : day.length ? 'none on ratio' : ''}
                      </div>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </Card>
        <p className="mt-2 text-[12px]" style={{ color: 'var(--nl-muted)' }}>
          Counts are people rostered. “On ratio” excludes trainees and volunteers,
          who are on the floor but never fill a ratio slot.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Btn to="/admin?tab=spreadsheet" variant="quiet" size="sm">Manage Staff Schedule</Btn>
        <Btn to="/admin?tab=payroll" variant="quiet" size="sm">Manage Payroll</Btn>
        <Btn to="/staffing-board" variant="quiet" size="sm">Staffing Board</Btn>
      </div>
    </div>
  );
}

/** Sunday-first week containing `iso`. Local noon, so no UTC day-slip. */
function weekOf(iso) {
  const d = asDate(iso);
  d.setDate(d.getDate() - d.getDay());
  const out = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    const p = (n) => String(n).padStart(2, '0');
    out.push(`${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`);
  }
  return out;
}

function hoursOf(s) {
  const [h1, m1] = String(s.startTime || '').split(':').map(Number);
  const [h2, m2] = String(s.endTime || '').split(':').map(Number);
  if (![h1, m1, h2, m2].every(Number.isFinite)) return 0;
  return Math.max(0, ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60);
}
