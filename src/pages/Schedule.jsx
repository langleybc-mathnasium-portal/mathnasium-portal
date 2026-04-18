import { useState, useEffect } from 'react';
import { collection, addDoc, deleteDoc, doc, onSnapshot, query, orderBy } from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { CalendarDays, Clock, Check, X, User, ArrowRightLeft } from 'lucide-react';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, isSameMonth, isSameDay, addMonths, subMonths } from 'date-fns';

export default function Schedule() {
  const { profile } = useAuth();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [startTime, setStartTime] = useState('15:00');
  const [endTime, setEndTime] = useState('20:00');
  const [showForm, setShowForm] = useState(false);

  useEffect(() => onSnapshot(query(collection(db, 'availability'), orderBy('date')), snap => {
    setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }), []);

  useEffect(() => onSnapshot(query(collection(db, 'shifts'), orderBy('date')), snap => {
    setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }), []);

  const handleAddAvailability = async (e) => {
    e.preventDefault();
    if (!selectedDate || !profile) return;
    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    await addDoc(collection(db, 'availability'), {
      userId: profile.uid, userName: profile.displayName,
      date: dateStr, startTime, endTime,
    });
    setShowForm(false);
  };

  const handleDeleteAvailability = async (id) => {
    await deleteDoc(doc(db, 'availability', id));
  };

  // Post shift to chat for swap
  const handlePostShiftToChat = async (shift) => {
    const dateFormatted = new Date(shift.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    await addDoc(collection(db, 'chat'), {
      text: `Is anyone able to swap or take my shift?\n\nShift: ${dateFormatted}, ${shift.startTime} - ${shift.endTime}${shift.role ? ` (${shift.role})` : ''}`,
      userId: profile.uid,
      userName: profile.displayName,
      userRole: profile.role,
      createdAt: serverTimestamp(),
      type: 'shift_swap',
      shiftId: shift.id,
      shiftDate: shift.date,
      shiftStartTime: shift.startTime,
      shiftEndTime: shift.endTime,
      shiftRole: shift.role || '',
      swapStatus: 'open',
      acceptedBy: null,
      acceptedByName: null,
    });
    alert('Your shift has been posted to the chat for swap!');
  };

  // Calendar rendering
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calStart = startOfWeek(monthStart);
  const calEnd = endOfWeek(monthEnd);
  const days = [];
  let day = calStart;
  while (day <= calEnd) { days.push(day); day = addDays(day, 1); }

  const dateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null;
  const dayAvailability = dateStr ? availability.filter(a => a.date === dateStr) : [];
  const myAvailability = dayAvailability.filter(a => a.userId === profile?.uid);
  const myShifts = dateStr ? shifts.filter(s => s.date === dateStr && s.userId === profile?.uid) : [];

  const myAvailDates = new Set(availability.filter(a => a.userId === profile?.uid).map(a => a.date));
  const myShiftDates = new Set(shifts.filter(s => s.userId === profile?.uid).map(s => s.date));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="rounded-lg bg-blue-100 p-2 text-blue-600"><CalendarDays size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Scheduling</h1>
          <p className="text-sm text-gray-500">Set your availability and view your shifts</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Calendar */}
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="rounded-lg p-1.5 hover:bg-gray-100 text-gray-600">&lt;</button>
            <h3 className="text-lg font-semibold text-gray-900">{format(currentMonth, 'MMMM yyyy')}</h3>
            <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="rounded-lg p-1.5 hover:bg-gray-100 text-gray-600">&gt;</button>
          </div>
          <div className="grid grid-cols-7 text-center text-xs font-medium text-gray-500 mb-2">
            {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => <div key={d} className="py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map((d, i) => {
              const ds = format(d, 'yyyy-MM-dd');
              const isToday = isSameDay(d, new Date());
              const isMonth = isSameMonth(d, currentMonth);
              const isSelected = selectedDate && isSameDay(d, selectedDate);
              const hasAvail = myAvailDates.has(ds);
              const hasShift = myShiftDates.has(ds);
              return (
                <button key={i} onClick={() => setSelectedDate(d)}
                  className={`relative rounded-lg p-2 text-sm transition-colors ${!isMonth ? 'text-gray-300' : isSelected ? 'bg-red-600 text-white' : isToday ? 'bg-yellow-100 font-bold text-yellow-800' : 'hover:bg-gray-100 text-gray-700'}`}>
                  {format(d, 'd')}
                  <div className="flex justify-center gap-0.5 mt-0.5">
                    {hasAvail && <div className="h-1.5 w-1.5 rounded-full bg-green-500" />}
                    {hasShift && <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
            <div className="flex items-center gap-1.5"><div className="h-2 w-2 rounded-full bg-green-500" /> Available</div>
            <div className="flex items-center gap-1.5"><div className="h-4 w-6 rounded border-2 border-blue-500 bg-blue-100" /> Assigned Shift</div>
          </div>
        </div>

        {/* Day detail */}
        <div className="space-y-4">
          {selectedDate ? (
            <div className="rounded-xl border bg-white p-5 shadow-sm">
              <h3 className="mb-4 text-sm font-semibold text-gray-900">{format(selectedDate, 'EEEE, MMM d, yyyy')}</h3>

              {/* My Shifts */}
              {myShifts.length > 0 && (
                <div className="mb-4">
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Your Shifts</h4>
                  {myShifts.map(s => (
                    <div key={s.id} className="mb-2 flex items-center justify-between rounded-lg bg-blue-50 px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Clock size={14} className="text-blue-600" />
                        <span className="font-medium text-blue-800">{s.startTime} - {s.endTime}</span>
                        {s.role && <span className="rounded bg-blue-200 px-1.5 py-0.5 text-xs text-blue-800">{s.role}</span>}
                      </div>
                      <button onClick={() => handlePostShiftToChat(s)} title="Post to chat for swap"
                        className="flex items-center gap-1 rounded-lg bg-orange-100 px-2 py-1 text-xs font-medium text-orange-700 hover:bg-orange-200 transition-colors">
                        <ArrowRightLeft size={12} /> Post
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* My Availability */}
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Your Availability</h4>
              {myAvailability.length > 0 ? (
                <div className="space-y-2">
                  {myAvailability.map(a => (
                    <div key={a.id} className="flex items-center justify-between rounded-lg bg-green-50 px-3 py-2">
                      <div className="flex items-center gap-2 text-sm">
                        <Check size={14} className="text-green-600" />
                        <span className="text-green-800">{a.startTime} - {a.endTime}</span>
                      </div>
                      <button onClick={() => handleDeleteAvailability(a.id)} className="text-gray-400 hover:text-red-500"><X size={14} /></button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No availability set for this day.</p>
              )}

              {!isSameDay(selectedDate, new Date()) && (
                <button onClick={() => setShowForm(!showForm)}
                  className="mt-3 w-full rounded-lg border border-dashed border-gray-300 px-4 py-2 text-sm text-gray-500 transition-colors hover:border-red-400 hover:text-red-600">
                  + Add Availability
                </button>
              )}

              {showForm && (
                <form onSubmit={handleAddAvailability} className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-xs text-gray-500">Start</label>
                      <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-gray-500">End</label>
                      <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700">Save</button>
                    <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50">Cancel</button>
                  </div>
                </form>
              )}
            </div>
          ) : (
            <div className="rounded-xl border bg-white p-8 text-center shadow-sm">
              <CalendarDays size={32} className="mx-auto mb-2 text-gray-300" />
              <p className="text-sm text-gray-500">Select a day on the calendar to view or set availability</p>
            </div>
          )}

          {/* All instructor availability (owner view) */}
          {profile?.role === 'owner' && selectedDate && dayAvailability.length > 0 && (
            <div className="rounded-xl border bg-white p-5 shadow-sm">
              <h4 className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500">All Instructor Availability</h4>
              <div className="space-y-2">
                {dayAvailability.map(a => (
                  <div key={a.id} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm">
                    <User size={14} className="text-gray-500" />
                    <span className="font-medium text-gray-800">{a.userName}</span>
                    <span className="text-gray-500">{a.startTime} - {a.endTime}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
