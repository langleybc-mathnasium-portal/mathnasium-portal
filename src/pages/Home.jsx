import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Megaphone, CalendarDays, MessageSquare, Users } from 'lucide-react';

const quickLinks = [
  { to: '/announcements', label: 'Announcements', desc: 'View latest news, fun days, and policies', icon: Megaphone, color: 'bg-red-50 text-red-600' },
  { to: '/schedule', label: 'Scheduling', desc: 'Submit availability and view shifts', icon: CalendarDays, color: 'bg-blue-50 text-blue-600' },
  { to: '/chat', label: 'Chat', desc: 'Talk with your team and swap shifts', icon: MessageSquare, color: 'bg-green-50 text-green-600' },
];

export default function Home() {
  const { profile } = useAuth();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Welcome back, {profile?.displayName?.split(' ')[0] || 'Instructor'}!</h1>
        <p className="mt-1 text-gray-500">Mathnasium Langley Instructor Portal - Your hub for schedules, announcements, and team communication.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {quickLinks.map(item => (
          <Link key={item.to} to={item.to} className="group rounded-xl border bg-white p-5 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5">
            <div className={`mb-3 inline-flex rounded-lg p-2.5 ${item.color}`}>
              <item.icon size={22} />
            </div>
            <h3 className="font-semibold text-gray-900 group-hover:text-red-600 transition-colors">{item.label}</h3>
            <p className="mt-1 text-sm text-gray-500">{item.desc}</p>
          </Link>
        ))}
        {profile?.role === 'owner' && (
          <Link to="/admin" className="group rounded-xl border bg-white p-5 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5">
            <div className="mb-3 inline-flex rounded-lg bg-purple-50 p-2.5 text-purple-600">
              <Users size={22} />
            </div>
            <h3 className="font-semibold text-gray-900 group-hover:text-red-600 transition-colors">Admin Panel</h3>
            <p className="mt-1 text-sm text-gray-500">Manage instructors, approve accounts, assign shifts</p>
          </Link>
        )}
      </div>
      <div className="mt-8 rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">About This Portal</h2>
        <div className="space-y-2 text-sm text-gray-600">
          <p>This portal is designed for Mathnasium Langley instructors to stay connected and organized.</p>
          <ul className="ml-4 list-disc space-y-1">
            <li><strong>Announcements:</strong> Stay up to date with newsletters, fun days, and important notices.</li>
            <li><strong>Scheduling:</strong> Submit your availability and view your assigned shifts on a calendar.</li>
            <li><strong>Chat:</strong> Communicate with your team, swap shifts, and ask questions.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
