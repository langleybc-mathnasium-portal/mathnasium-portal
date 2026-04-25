import { useState, useEffect, useMemo } from 'react';
import {
  collection, addDoc, deleteDoc, doc, onSnapshot,
  query, orderBy, updateDoc,
} from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  CalendarDays, ChevronLeft, ChevronRight, Clock,
  ArrowRightLeft, Plus, X, Check, AlertTriangle, Briefcase,
} from 'lucide-react';
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  getDay, addMonths, subMonths, isSameDay, isSameMonth,
} from 'date-fns';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── Cell Modal ──────────────────────────────────────────────────────────────

function DayModal({ date, myAvailability, myShift, openShifts, timeOffDates, onClose, onSaveAvail, onDeleteAvail, onPostSwap, onClaimOpenShift, onRequestTimeOff }) {
  const [mode, setMode] = useState('main'); // 'main' | 'avail' | 'timeoff'
  const [startTime, setStartTime] = useState('15:00');
  const [endTime, setEndTime]     = useState('20:00');
  const [reason, setReason]       = useState('');
  const [toStart, setToStart]     = useState(format(date, 'yyyy-MM-dd'));
  const [toEnd, setToEnd]         = useState(format(date, 'yyyy-MM-dd'));

  const dateStr = format(date, 'yyyy-MM-dd');
  const hasTimeOff = timeOffDates.has(dateStr);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide">{format(date, 'EEEE')}</p>
            <h3 className="text-lg font-bold text-gray-900">{format(date, 'MMMM d, yyyy')}</h3>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-3">
          {mode === 'main' && (
            <>
              {/* My Shift */}
              {myShift && (
                <div className="rounded-xl bg-blue-50 border border-blue-200 p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Briefcase size={14} className="text-blue-600" />
                    <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Your Shift</span>
                  </div>
                  <p className="text-sm font-bold text-blue-900">{fmtTime(myShift.startTime)} – {fmtTime(myShift.endTime)}</p>
                  {myShift.role && <p className="text-xs text-blue-600 mt-0.5">{myShift.role}</p>}
                  <button
                    onClick={() => onPostSwap(myShift)}
                    className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-lg bg-orange-100 px-3 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-200 transition-colors">
                    <ArrowRightLeft size={12} /> Post for Swap
                  </button>
                </div>
              )}

              {/* Time Off */}
              {hasTimeOff && (
                <div className="rounded-xl bg-red-50 border border-red-200 p-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-red-500" />
                    <span className="text-xs font-semibold text-red-700">Time Off Requested</span>
                  </div>
                </div>
              )}

              {/* My Availability */}
              {myAvailability ? (
                <div className="rounded-xl bg-green-50 border border-green-200 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <Check size={14} className="text-green-600" />
                        <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">Available</span>
                      </div>
                      <p className="text-sm font-bold text-green-900">{fmtTime(myAvailability.startTime)} – {fmtTime(myAvailability.endTime)}</p>
                    </div>
                    <button onClick={() => onDeleteAvail(myAvailability.id)} className="text-gray-400 hover:text-red-500 p-1"><X size={14} /></button>
                  </div>
                </div>
              ) : !myShift && !hasTimeOff && (
                <button onClick={() => setMode('avail')}
                  className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-green-300 px-4 py-3 text-sm font-medium text-green-700 hover:bg-green-50 transition-colors">
                  <Plus size={15} /> Set Availability
                </button>
              )}

              {/* Open Shifts */}
              {openShifts.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Open Shifts</p>
                  {openShifts.map(s => (
                    <div key={s.id} className="rounded-xl bg-orange-50 border border-orange-200 p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-bold text-orange-900">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</p>
                          {s.role && <p className="text-xs text-orange-600">{s.role}</p>}
                        </div>
                        <button onClick={() => onClaimOpenShift(s)}
                          className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-600 transition-colors">
                          Claim
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Request Time Off button */}
              {!hasTimeOff && (
                <button onClick={() => setMode('timeoff')}
                  className="w-full flex items-center justify-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors">
                  <AlertTriangle size={14} /> Request Time Off
                </button>
              )}
            </>
          )}

          {mode === 'avail' && (
            <>
              <p className="text-sm font-medium text-gray-700">Set your availability for this day</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">From</label>
                  <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-green-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">To</label>
                  <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-green-500 focus:outline-none" />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => onSaveAvail(dateStr, startTime, endTime)}
                  className="flex-1 rounded-lg bg-green-600 py-2 text-sm font-semibold text-white hover:bg-green-700">Save</button>
                <button onClick={() => setMode('main')}
                  className="flex-1 rounded-lg border py-2 text-sm text-gray-500 hover:bg-gray-50">Cancel</button>
              </div>
            </>
          )}

          {mode === 'timeoff' && (
            <>
              <p className="text-sm font-medium text-gray-700">Request time off</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">From</label>
                  <input type="date" value={toStart} onChange={e => setToStart(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">To</label>
                  <input type="date" value={toEnd} onChange={e => setToEnd(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Reason <span className="text-red-500">*</span></label>
                <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
                  placeholder="e.g. Family event, exam, personal..."
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none resize-none" />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => {
                    if (!reason.trim()) { alert('Please enter a reason.'); return; }
                    onRequestTimeOff(toStart, toEnd, reason.trim());
                  }}
                  className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-700">
                  Submit Request
                </button>
                <button onClick={() => setMode('main')}
                  className="flex-1 rounded-lg border py-2 text-sm text-gray-500 hover:bg-gray-50">Cancel</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Schedule() {
  const { profile } = useAuth();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(null);
  const [availability, setAvailability]  = useState([]);
  const [shifts, setShifts]              = useState([]);
  const [openShifts, setOpenShifts]      = useState([]);
  const [timeOffRequests, setTimeOffRequests] = useState([]);

  // ── Firestore listeners ──
  useEffect(() => onSnapshot(query(collection(db, 'availability'), orderBy('date')), snap =>
    setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  useEffect(() => onSnapshot(query(collection(db, 'shifts'), orderBy('date')), snap =>
    setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  useEffect(() => onSnapshot(query(collection(db, 'openShifts')), snap =>
    setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  useEffect(() => onSnapshot(query(collection(db, 'timeOffRequests'), orderBy('createdAt', 'desc')), snap =>
    setTimeOffRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  // ── Calendar grid ──
  const monthStart = startOfMonth(currentMonth);
  const monthEnd   = endOfMonth(currentMonth);
  const days       = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const startPad   = getDay(monthStart); // 0=Sun blanks before first day

  // ── My data ──
  const myShifts      = useMemo(() => shifts.filter(s => s.userId === profile?.uid), [shifts, profile]);
  const myAvailMap    = useMemo(() => {
    const m = {};
    availability.filter(a => a.userId === profile?.uid).forEach(a => { m[a.date] = a; });
    return m;
  }, [availability, profile]);
  const myTimeOffDates = useMemo(() => {
    const dates = new Set();
    timeOffRequests
      .filter(r => r.userId === profile?.uid && r.status !== 'denied')
      .forEach(r => {
        let d = new Date(r.startDate + 'T00:00:00');
        const end = new Date(r.endDate + 'T00:00:00');
        while (d <= end) {
          dates.add(format(d, 'yyyy-MM-dd'));
          d.setDate(d.getDate() + 1);
        }
      });
    return dates;
  }, [timeOffRequests, profile]);

  // ── Handlers ──
  const handleSaveAvail = async (dateStr, startTime, endTime) => {
    // Remove existing first
    const existing = myAvailMap[dateStr];
    if (existing) await deleteDoc(doc(db, 'availability', existing.id));
    await addDoc(collection(db, 'availability'), {
      userId: profile.uid, userName: profile.displayName,
      date: dateStr, startTime, endTime,
    });
    setSelectedDate(null);
  };

  const handleDeleteAvail = async (id) => {
    await deleteDoc(doc(db, 'availability', id));
    setSelectedDate(null);
  };

  const handlePostSwap = async (shift) => {
    const dateFormatted = new Date(shift.date + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric',
    });
    await addDoc(collection(db, 'chat'), {
      text: `Is anyone able to swap or take my shift?\n\nShift: ${dateFormatted}, ${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)}${shift.role ? ` (${shift.role})` : ''}`,
      userId: profile.uid, userName: profile.displayName, userRole: profile.role,
      createdAt: serverTimestamp(), type: 'shift_swap',
      shiftId: shift.id, shiftDate: shift.date,
      shiftStartTime: shift.startTime, shiftEndTime: shift.endTime,
      shiftRole: shift.role || '', swapStatus: 'open',
      acceptedBy: null, acceptedByName: null,
    });
    setSelectedDate(null);
    alert('Shift posted to chat for swap!');
  };

  const handleClaimOpenShift = async (openShift) => {
    if (openShift.status !== 'open') { alert('This shift has already been claimed.'); return; }
    // Mark open shift as claimed
    await updateDoc(doc(db, 'openShifts', openShift.id), {
      status: 'claimed', claimedBy: profile.uid, claimedByName: profile.displayName,
    });
    // Create a real shift for this instructor
    await addDoc(collection(db, 'shifts'), {
      userId: profile.uid, userName: profile.displayName,
      date: openShift.date, startTime: openShift.startTime, endTime: openShift.endTime,
      role: openShift.role || profile.instructorType || 'Instructor',
      status: 'live', autoScheduled: false,
    });
    // Post to chat
    const dateFormatted = new Date(openShift.date + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric',
    });
    await addDoc(collection(db, 'chat'), {
      text: `✅ ${profile.displayName} has claimed the open shift on ${dateFormatted} (${fmtTime(openShift.startTime)} – ${fmtTime(openShift.endTime)}).`,
      userId: 'system', userName: 'Mathnasium Langley', userRole: 'system',
      createdAt: serverTimestamp(), type: 'shift_confirmation',
    });
    setSelectedDate(null);
    alert('Shift claimed! It has been added to your schedule.');
  };

  const handleRequestTimeOff = async (startDate, endDate, reason) => {
    await addDoc(collection(db, 'timeOffRequests'), {
      userId: profile.uid, userName: profile.displayName,
      startDate, endDate, reason,
      status: 'pending',
      createdAt: serverTimestamp(),
    });
    setSelectedDate(null);
    alert('Time off request submitted! The admin team will review it.');
  };

  // ── Cell state logic ──
  const getCellState = (dateStr) => {
    const shift = myShifts.find(s => s.date === dateStr);
    if (shift) return { type: 'shift', shift };
    if (myTimeOffDates.has(dateStr)) return { type: 'timeoff' };
    const avail = myAvailMap[dateStr];
    if (avail) return { type: 'available', avail };
    const dayOpenShifts = openShifts.filter(s => s.date === dateStr && s.status === 'open');
    if (dayOpenShifts.length > 0) return { type: 'open', openShifts: dayOpenShifts };
    return { type: 'empty' };
  };

  const today = format(new Date(), 'yyyy-MM-dd');

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="rounded-lg bg-blue-100 p-2 text-blue-600"><CalendarDays size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Schedule</h1>
          <p className="text-sm text-gray-500">View shifts, set availability, and manage time off</p>
        </div>
      </div>

      {/* Legend */}
      <div className="mb-4 flex flex-wrap items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-blue-400 inline-block" /> Assigned Shift</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-green-400 inline-block" /> Available</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-orange-400 inline-block" /> Open Shift</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-300 inline-block" /> Time Off</span>
      </div>

      {/* Calendar */}
      <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
        {/* Month nav */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
            className="rounded-lg p-1.5 hover:bg-gray-100 text-gray-600"><ChevronLeft size={18} /></button>
          <h2 className="text-base font-bold text-gray-900">{format(currentMonth, 'MMMM yyyy')}</h2>
          <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
            className="rounded-lg p-1.5 hover:bg-gray-100 text-gray-600"><ChevronRight size={18} /></button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 border-b">
          {DAY_HEADERS.map(d => (
            <div key={d} className="py-2 text-center text-xs font-semibold text-gray-400 uppercase tracking-wide">{d}</div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-7">
          {/* Blank padding cells */}
          {Array.from({ length: startPad }).map((_, i) => (
            <div key={`pad-${i}`} className="min-h-[90px] border-b border-r bg-gray-50/50" />
          ))}

          {/* Day cells */}
          {days.map((day) => {
            const dateStr = format(day, 'yyyy-MM-dd');
            const isToday = dateStr === today;
            const inMonth = isSameMonth(day, currentMonth);
            const state   = getCellState(dateStr);
            const isPast  = day < new Date() && !isToday;

            // Cell background & content
            let cellBg = 'bg-white hover:bg-gray-50';
            let content = null;

            if (state.type === 'shift') {
              cellBg = 'bg-blue-50 hover:bg-blue-100 cursor-pointer';
              content = (
                <div className="mt-1 rounded-md bg-blue-500 px-1.5 py-1">
                  <p className="text-white text-xs font-bold leading-tight">
                    {fmtTime(state.shift.startTime)}–{fmtTime(state.shift.endTime)}
                  </p>
                  {state.shift.role && (
                    <p className="text-blue-100 text-xs uppercase tracking-wide leading-tight">{state.shift.role}</p>
                  )}
                </div>
              );
            } else if (state.type === 'available') {
              cellBg = 'bg-green-50 hover:bg-green-100 cursor-pointer';
              content = (
                <div className="mt-1 rounded-md bg-green-500 px-1.5 py-1">
                  <p className="text-white text-xs font-semibold leading-tight">Available</p>
                  <p className="text-green-100 text-xs leading-tight">
                    {fmtTime(state.avail.startTime)}–{fmtTime(state.avail.endTime)}
                  </p>
                </div>
              );
            } else if (state.type === 'open') {
              cellBg = 'bg-orange-50 hover:bg-orange-100 cursor-pointer';
              content = (
                <div className="mt-1 rounded-md bg-orange-400 px-1.5 py-1">
                  <p className="text-white text-xs font-semibold leading-tight">
                    {state.openShifts.length} Open Shift{state.openShifts.length > 1 ? 's' : ''}
                  </p>
                </div>
              );
            } else if (state.type === 'timeoff') {
              cellBg = 'bg-red-50 cursor-pointer';
              content = (
                <div className="mt-1 rounded-md bg-red-300 px-1.5 py-1">
                  <p className="text-white text-xs font-semibold leading-tight">Time Off</p>
                </div>
              );
            } else if (!isPast) {
              cellBg = 'bg-white hover:bg-gray-50 cursor-pointer';
            }

            return (
              <div
                key={dateStr}
                onClick={() => !isPast && setSelectedDate(day)}
                className={`min-h-[90px] border-b border-r p-1.5 transition-colors ${cellBg} ${!inMonth ? 'opacity-30' : ''} ${isToday ? 'ring-2 ring-inset ring-red-400' : ''}`}
              >
                <span className={`text-xs font-semibold ${isToday ? 'text-red-600' : 'text-gray-700'}`}>
                  {format(day, 'd')}
                </span>
                {content}
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary stats */}
      <div className="mt-4 grid grid-cols-3 gap-3">
        {[
          {
            label: 'Shifts This Month',
            value: myShifts.filter(s => s.date >= format(monthStart, 'yyyy-MM-dd') && s.date <= format(monthEnd, 'yyyy-MM-dd')).length,
            color: 'text-blue-600', bg: 'bg-blue-50',
          },
          {
            label: 'Hours This Month',
            value: myShifts
              .filter(s => s.date >= format(monthStart, 'yyyy-MM-dd') && s.date <= format(monthEnd, 'yyyy-MM-dd'))
              .reduce((sum, s) => {
                if (!s.startTime || !s.endTime) return sum;
                const [sh, sm] = s.startTime.split(':').map(Number);
                const [eh, em] = s.endTime.split(':').map(Number);
                return sum + ((eh + em / 60) - (sh + sm / 60));
              }, 0).toFixed(1) + 'h',
            color: 'text-green-600', bg: 'bg-green-50',
          },
          {
            label: 'Open Shifts Available',
            value: openShifts.filter(s =>
              s.status === 'open' &&
              s.date >= format(monthStart, 'yyyy-MM-dd') &&
              s.date <= format(monthEnd, 'yyyy-MM-dd')
            ).length,
            color: 'text-orange-600', bg: 'bg-orange-50',
          },
        ].map(stat => (
          <div key={stat.label} className={`rounded-xl border ${stat.bg} p-4 text-center`}>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Day Modal */}
      {selectedDate && (
        <DayModal
          date={selectedDate}
          myAvailability={myAvailMap[format(selectedDate, 'yyyy-MM-dd')]}
          myShift={myShifts.find(s => s.date === format(selectedDate, 'yyyy-MM-dd'))}
          openShifts={openShifts.filter(s => s.date === format(selectedDate, 'yyyy-MM-dd') && s.status === 'open')}
          timeOffDates={myTimeOffDates}
          onClose={() => setSelectedDate(null)}
          onSaveAvail={handleSaveAvail}
          onDeleteAvail={handleDeleteAvail}
          onPostSwap={handlePostSwap}
          onClaimOpenShift={handleClaimOpenShift}
          onRequestTimeOff={handleRequestTimeOff}
        />
      )}
    </div>
  );
}
