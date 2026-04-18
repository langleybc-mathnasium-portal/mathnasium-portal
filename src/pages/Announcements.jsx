import { useState, useEffect } from 'react';
import { collection, addDoc, deleteDoc, doc, onSnapshot, query, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { Megaphone, Plus, Trash2, Pin } from 'lucide-react';

const CATEGORIES = {
  general: { bg: 'bg-gray-100', text: 'text-gray-700', label: 'General' },
  'fun-day': { bg: 'bg-green-100', text: 'text-green-700', label: 'Fun Day' },
  policy: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Policy' },
  urgent: { bg: 'bg-red-100', text: 'text-red-700', label: 'Urgent' },
};

export default function Announcements() {
  const { profile } = useAuth();
  const [posts, setPosts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [category, setCategory] = useState('general');
  const [pinned, setPinned] = useState(false);

  useEffect(() => onSnapshot(query(collection(db, 'announcements'), orderBy('date', 'desc')), snap => {
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    data.sort((a, b) => a.pinned && !b.pinned ? -1 : !a.pinned && b.pinned ? 1 : 0);
    setPosts(data);
  }), []);

  const handlePost = async (e) => {
    e.preventDefault();
    if (!title.trim() || !text.trim()) return;
    await addDoc(collection(db, 'announcements'), {
      title, text, author: profile?.displayName || 'Unknown',
      date: new Date().toISOString(), pinned, category,
    });
    setTitle(''); setText(''); setCategory('general'); setPinned(false); setShowForm(false);
  };

  const handleDelete = async (id) => {
    if (confirm('Delete this announcement?')) await deleteDoc(doc(db, 'announcements', id));
  };

  const isOwner = profile?.role === 'owner';

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-red-100 p-2 text-red-600"><Megaphone size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
            <p className="text-sm text-gray-500">Stay updated with the latest news</p>
          </div>
        </div>
        {isOwner && (
          <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-700">
            <Plus size={16} /> New Post
          </button>
        )}
      </div>

      {showForm && isOwner && (
        <form onSubmit={handlePost} className="mb-6 rounded-xl border bg-white p-6 shadow-sm">
          <h3 className="mb-4 font-semibold text-gray-900">Create Announcement</h3>
          <div className="space-y-3">
            <input className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20" placeholder="Announcement title" value={title} onChange={e => setTitle(e.target.value)} required />
            <textarea className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20" rows={4} placeholder="Write your announcement..." value={text} onChange={e => setText(e.target.value)} required />
            <div className="flex flex-wrap items-center gap-4">
              <select value={category} onChange={e => setCategory(e.target.value)} className="rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
                {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} className="rounded" /> Pin to top
              </label>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">Post</button>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border px-4 py-2 text-sm text-gray-500 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </form>
      )}

      <div className="space-y-4">
        {posts.length === 0 ? (
          <div className="rounded-xl border bg-white p-8 text-center shadow-sm">
            <Megaphone size={32} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-500">No announcements yet.</p>
          </div>
        ) : posts.map(post => {
          const cat = CATEGORIES[post.category] || CATEGORIES.general;
          return (
            <div key={post.id} className="rounded-xl border bg-white p-5 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                {post.pinned && <Pin size={14} className="text-red-500" />}
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${cat.bg} ${cat.text}`}>{cat.label}</span>
                <span className="text-xs text-gray-400">{post.date ? new Date(post.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</span>
              </div>
              <h3 className="mb-1 text-lg font-semibold text-gray-900">{post.title}</h3>
              <p className="mb-3 whitespace-pre-wrap text-sm text-gray-600">{post.text}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Posted by {post.author}</span>
                {isOwner && <button onClick={() => handleDelete(post.id)} className="text-gray-400 hover:text-red-500"><Trash2 size={16} /></button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
