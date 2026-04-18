import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Logo from './Logo';
import { House, Megaphone, CalendarDays, MessageSquare, Settings, LogOut, Menu, X, Bell } from 'lucide-react';

const navItems = [
  { to: '/', label: 'Home', icon: House },
  { to: '/announcements', label: 'Announcements', icon: Megaphone },
  { to: '/schedule', label: 'Scheduling', icon: CalendarDays },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
];

const adminItems = [
  { to: '/admin', label: 'Admin Panel', icon: Settings },
];

export default function Layout({ children }) {
  const { profile, logout } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  const items = profile?.role === 'owner' ? [...navItems, ...adminItems] : navItems;

  return (
    <div className="flex h-screen bg-gray-50">
      {open && <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-30 w-64 transform bg-gradient-to-b from-gray-900 to-gray-800 text-white transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center gap-3 border-b border-gray-700 px-5 py-5">
          <Logo size={40} />
          <div>
            <h1 className="text-lg font-bold leading-tight text-white">Mathnasium</h1>
            <p className="text-xs text-gray-400">Langley Instructor Portal</p>
          </div>
          <button className="ml-auto lg:hidden" onClick={() => setOpen(false)}>
            <X size={20} />
          </button>
        </div>
        <nav className="mt-4 flex flex-col gap-1 px-3">
          {items.map(item => {
            const active = location.pathname === item.to;
            return (
              <Link key={item.to} to={item.to} onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${active ? 'bg-red-600 text-white shadow-md' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}>
                <item.icon size={18} />
                {item.label}
              </Link>
            );
          })}
          {/* Notification Preferences link */}
          <Link to="/notifications" onClick={() => setOpen(false)}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${location.pathname === '/notifications' ? 'bg-red-600 text-white shadow-md' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}>
            <Bell size={18} />
            Notifications
          </Link>
        </nav>
        <div className="absolute bottom-0 left-0 right-0 border-t border-gray-700 p-4">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-600 text-sm font-bold">
              {profile?.displayName?.charAt(0)?.toUpperCase() || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{profile?.displayName || 'User'}</p>
              <p className="truncate text-xs text-gray-400">{profile?.role === 'owner' ? 'Owner' : 'Instructor'}</p>
            </div>
          </div>
          <button onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-700 hover:text-white">
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b bg-white px-4 py-3 shadow-sm lg:hidden">
          <button onClick={() => setOpen(true)}>
            <Menu size={24} className="text-gray-700" />
          </button>
          <div className="flex items-center gap-2">
            <Logo size={28} />
            <span className="font-bold text-gray-900">Mathnasium Langley</span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
