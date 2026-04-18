import { useState, useEffect, useRef } from 'react';
import { collection, addDoc, onSnapshot, query, orderBy, limit, doc, updateDoc, getDoc } from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { MessageSquare, Send, ArrowRightLeft, CheckCircle } from 'lucide-react';

export default function Chat() {
  const { profile } = useAuth();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => onSnapshot(
    query(collection(db, 'chat'), orderBy('createdAt', 'asc'), limit(200)),
    snap => setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!text.trim() || !profile || sending) return;
    setSending(true);
    try {
      await addDoc(collection(db, 'chat'), {
        text: text.trim(),
        userId: profile.uid,
        userName: profile.displayName,
        userRole: profile.role,
        createdAt: serverTimestamp(),
        type: 'message',
      });
      setText('');
    } finally {
      setSending(false);
    }
  };

  const handleAcceptShift = async (msg) => {
    if (!profile || msg.userId === profile.uid) return;
    if (msg.swapStatus !== 'open') {
      alert('This shift has already been taken!');
      return;
    }

    try {
      // Update the chat message to mark as accepted
      await updateDoc(doc(db, 'chat', msg.id), {
        swapStatus: 'accepted',
        acceptedBy: profile.uid,
        acceptedByName: profile.displayName,
      });

      // Update the shift assignment - transfer it to the acceptor
      if (msg.shiftId) {
        const shiftRef = doc(db, 'shifts', msg.shiftId);
        const shiftSnap = await getDoc(shiftRef);
        if (shiftSnap.exists()) {
          await updateDoc(shiftRef, {
            userId: profile.uid,
            userName: profile.displayName,
          });
        }
      }

      // Post a confirmation message
      await addDoc(collection(db, 'chat'), {
        text: `${profile.displayName} has taken ${msg.userName}'s shift on ${msg.shiftDate} (${msg.shiftStartTime} - ${msg.shiftEndTime}).`,
        userId: 'system',
        userName: 'System',
        userRole: 'system',
        createdAt: serverTimestamp(),
        type: 'shift_confirmation',
      });
    } catch {
      alert('Failed to accept shift. It may have already been taken.');
    }
  };

  const formatTime = (ts) => ts ? new Date(ts.seconds * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const initials = (name) => name?.split(' ').map(w => w.charAt(0)).join('').toUpperCase().slice(0, 2) || '??';

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <div className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-green-100 p-2 text-green-600"><MessageSquare size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Team Chat</h1>
          <p className="text-sm text-gray-500">Swap shifts, ask questions, and stay connected</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl border bg-white shadow-sm">
        <div className="p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="py-16 text-center">
              <MessageSquare size={40} className="mx-auto mb-3 text-gray-300" />
              <p className="text-gray-500">No messages yet. Start the conversation!</p>
            </div>
          ) : messages.map(msg => {
            const isMe = msg.userId === profile?.uid;
            const isSystem = msg.userId === 'system';
            const isShiftSwap = msg.type === 'shift_swap';
            const isConfirmation = msg.type === 'shift_confirmation';
            const isOpenShiftAlert = msg.type === 'open_shift_alert';
            const isSchedulePosted = msg.type === 'schedule_posted';

            // Open shift alert — distinct blue card with link hint
            if (isOpenShiftAlert) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="w-full max-w-md rounded-xl border-2 border-blue-200 bg-blue-50 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-lg">📢</span>
                      <span className="text-sm font-semibold text-blue-800">Open Shift Available</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-blue-700 mb-1">{msg.text.replace('📢 Open shift available!\n\n', '')}</p>
                    <div className="text-xs text-blue-400 mt-2">{formatTime(msg.createdAt)}</div>
                  </div>
                </div>
              );
            }

            // Schedule posted announcement
            if (isSchedulePosted) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="w-full max-w-md rounded-xl border-2 border-purple-200 bg-purple-50 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-lg">📅</span>
                      <span className="text-sm font-semibold text-purple-800">Schedule Posted</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-purple-700">{msg.text.replace('📅 ', '')}</p>
                    <div className="text-xs text-purple-400 mt-2">{formatTime(msg.createdAt)}</div>
                  </div>
                </div>
              );
            }

            if (isSystem || isConfirmation) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="flex items-center gap-2 rounded-full bg-green-50 px-4 py-2 text-xs font-medium text-green-700 border border-green-200">
                    <CheckCircle size={14} />
                    {msg.text}
                  </div>
                </div>
              );
            }

            if (isShiftSwap) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="w-full max-w-md rounded-xl border-2 border-orange-200 bg-orange-50 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <ArrowRightLeft size={16} className="text-orange-600" />
                      <span className="text-sm font-semibold text-orange-800">Shift Swap Request</span>
                      <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${msg.swapStatus === 'open' ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'}`}>
                        {msg.swapStatus === 'open' ? 'Open' : 'Taken'}
                      </span>
                    </div>
                    <div className="mb-1 text-xs text-gray-500">
                      {msg.userName} &middot; {formatTime(msg.createdAt)}
                    </div>
                    <p className="mb-3 whitespace-pre-wrap text-sm text-gray-700">{msg.text}</p>
                    {msg.swapStatus === 'open' && !isMe ? (
                      <button onClick={() => handleAcceptShift(msg)}
                        className="w-full rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors">
                        Take This Shift
                      </button>
                    ) : msg.swapStatus === 'accepted' ? (
                      <div className="flex items-center gap-2 rounded-lg bg-green-100 px-3 py-2 text-sm text-green-700">
                        <CheckCircle size={16} />
                        Taken by {msg.acceptedByName}
                      </div>
                    ) : isMe && msg.swapStatus === 'open' ? (
                      <div className="rounded-lg bg-yellow-100 px-3 py-2 text-sm text-yellow-700 text-center">
                        Waiting for someone to take this shift...
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            }

            return (
              <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''}`}>
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${msg.userRole === 'owner' ? 'bg-red-600' : 'bg-gray-600'}`}>
                  {initials(msg.userName)}
                </div>
                <div className={`max-w-xs sm:max-w-sm ${isMe ? 'text-right' : ''}`}>
                  <div className="mb-0.5 flex items-center gap-2">
                    <span className={`text-xs font-medium ${isMe ? 'text-red-600' : 'text-gray-700'}`}>{isMe ? 'You' : msg.userName}</span>
                    {msg.userRole === 'owner' && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600">Owner</span>}
                    <span className="text-xs text-gray-400">{formatTime(msg.createdAt)}</span>
                  </div>
                  <div className={`inline-block rounded-2xl px-4 py-2 text-sm ${isMe ? 'bg-red-600 text-white rounded-br-md' : 'bg-gray-100 text-gray-800 rounded-bl-md'}`}>
                    {msg.text}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      <form onSubmit={handleSend} className="mt-3 flex items-center gap-2">
        <input className="flex-1 rounded-xl border bg-white px-4 py-3 text-sm shadow-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
          placeholder="Type a message..." value={text} onChange={e => setText(e.target.value)} />
        <button type="submit" disabled={!text.trim() || sending}
          className="rounded-xl bg-red-600 p-3 text-white shadow-sm transition-colors hover:bg-red-700 disabled:opacity-50">
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
