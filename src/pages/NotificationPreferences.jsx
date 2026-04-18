import { useState, useEffect } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { Bell, BellOff, Mail, Phone, Clock, ChevronLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

const REMINDER_OPTIONS = [
  { value: 'none', label: 'No reminders', desc: 'I do not want shift reminders' },
  { value: '1hour', label: '1 hour before', desc: 'Get notified 1 hour before your shift' },
  { value: '3hours', label: '3 hours before', desc: 'Get notified 3 hours before your shift' },
  { value: '1day', label: '1 day before', desc: 'Get notified the day before your shift' },
  { value: '2days', label: '2 days before', desc: 'Get notified 2 days before your shift' },
];

export default function NotificationPreferences() {
  const { profile } = useAuth();
  const [prefs, setPrefs] = useState({
    emailEnabled: true,
    smsEnabled: false,
    reminderTiming: '1day',
    email: '',
    phone: '',
    shiftSwapNotify: true,
    announcementNotify: true,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profile?.uid) return;
    const loadPrefs = async () => {
      const snap = await getDoc(doc(db, 'notificationPreferences', profile.uid));
      if (snap.exists()) {
        setPrefs(prev => ({ ...prev, ...snap.data() }));
      } else {
        setPrefs(prev => ({ ...prev, email: profile.email || '' }));
      }
      setLoading(false);
    };
    loadPrefs();
  }, [profile]);

  const handleSave = async () => {
    if (!profile?.uid) return;
    setSaving(true);
    try {
      await setDoc(doc(db, 'notificationPreferences', profile.uid), {
        ...prefs,
        userId: profile.uid,
        userName: profile.displayName,
        updatedAt: new Date().toISOString(),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-red-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft size={16} /> Back to Home
        </Link>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-orange-100 p-2 text-orange-600"><Bell size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Notification Preferences</h1>
            <p className="text-sm text-gray-500">Configure how and when you receive shift reminders</p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {/* Reminder Timing */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h3 className="mb-1 font-semibold text-gray-900 flex items-center gap-2">
            <Clock size={18} className="text-blue-600" /> Shift Reminder Timing
          </h3>
          <p className="mb-4 text-sm text-gray-500">Choose when to receive reminders before your upcoming shifts</p>
          <div className="space-y-2">
            {REMINDER_OPTIONS.map(opt => (
              <label key={opt.value}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border-2 px-4 py-3 transition-colors ${prefs.reminderTiming === opt.value ? 'border-red-500 bg-red-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <input type="radio" name="timing" value={opt.value} checked={prefs.reminderTiming === opt.value}
                  onChange={() => setPrefs(p => ({ ...p, reminderTiming: opt.value }))} className="accent-red-600" />
                <div>
                  <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                  <p className="text-xs text-gray-500">{opt.desc}</p>
                </div>
                {opt.value === 'none' && <BellOff size={16} className="ml-auto text-gray-400" />}
              </label>
            ))}
          </div>
        </div>

        {/* Notification Channels */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h3 className="mb-4 font-semibold text-gray-900">Notification Channels</h3>

          <div className="space-y-4">
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Mail size={18} className="text-blue-600" />
                  <span className="font-medium text-gray-900">Email Notifications</span>
                </div>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input type="checkbox" checked={prefs.emailEnabled}
                    onChange={e => setPrefs(p => ({ ...p, emailEnabled: e.target.checked }))} className="peer sr-only" />
                  <div className="peer h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-red-600 peer-checked:after:translate-x-full peer-checked:after:border-white" />
                </label>
              </div>
              {prefs.emailEnabled && (
                <input type="email" value={prefs.email} onChange={e => setPrefs(p => ({ ...p, email: e.target.value }))}
                  placeholder="your@email.com" className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
              )}
            </div>

            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Phone size={18} className="text-green-600" />
                  <span className="font-medium text-gray-900">Text (SMS) Notifications</span>
                </div>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input type="checkbox" checked={prefs.smsEnabled}
                    onChange={e => setPrefs(p => ({ ...p, smsEnabled: e.target.checked }))} className="peer sr-only" />
                  <div className="peer h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-red-600 peer-checked:after:translate-x-full peer-checked:after:border-white" />
                </label>
              </div>
              {prefs.smsEnabled && (
                <input type="tel" value={prefs.phone} onChange={e => setPrefs(p => ({ ...p, phone: e.target.value }))}
                  placeholder="+1 (604) 555-0123" className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
              )}
            </div>
          </div>
        </div>

        {/* Additional notification types */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h3 className="mb-4 font-semibold text-gray-900">Other Notifications</h3>
          <div className="space-y-3">
            <label className="flex items-center justify-between rounded-lg border px-4 py-3 cursor-pointer hover:bg-gray-50">
              <span className="text-sm text-gray-700">Shift swap requests in chat</span>
              <input type="checkbox" checked={prefs.shiftSwapNotify}
                onChange={e => setPrefs(p => ({ ...p, shiftSwapNotify: e.target.checked }))} className="accent-red-600 h-4 w-4" />
            </label>
            <label className="flex items-center justify-between rounded-lg border px-4 py-3 cursor-pointer hover:bg-gray-50">
              <span className="text-sm text-gray-700">New announcements</span>
              <input type="checkbox" checked={prefs.announcementNotify}
                onChange={e => setPrefs(p => ({ ...p, announcementNotify: e.target.checked }))} className="accent-red-600 h-4 w-4" />
            </label>
          </div>
        </div>

        {/* Save button */}
        <div className="flex items-center gap-3">
          <button onClick={handleSave} disabled={saving}
            className="rounded-lg bg-red-600 px-6 py-2.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-red-700 disabled:opacity-50">
            {saving ? 'Saving...' : 'Save Preferences'}
          </button>
          {saved && <span className="text-sm font-medium text-green-600">Preferences saved!</span>}
        </div>
      </div>
    </div>
  );
}
