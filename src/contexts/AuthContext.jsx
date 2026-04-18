import { createContext, useContext, useState, useEffect } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';

const AuthContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setUser(u);
    if (u) {
      const snap = await getDoc(doc(db, 'users', u.uid));
      snap.exists() ? setProfile(snap.data()) : setProfile(null);
    } else {
      setProfile(null);
    }
    setLoading(false);
  }), []);

  const login = async (email, password) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  /**
   * signup
   * @param {string} email
   * @param {string} password
   * @param {string} displayName
   * @param {Object} extras - { instructorType, phone }
   */
  const signup = async (email, password, displayName, extras = {}) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const profileData = {
      uid: cred.user.uid,
      email,
      displayName,
      role: 'instructor',
      approved: false,
      // Scheduling fields (set defaults; admin can edit)
      instructorType: extras.instructorType || 'Instructor',
      priority: 2,           // Admin sets this (1=high, 2=medium, 3=low)
      maxDaysPerWeek: 5,     // Admin can override
      phone: extras.phone || '',
      createdAt: new Date().toISOString(),
    };
    await setDoc(doc(db, 'users', cred.user.uid), profileData);
    setProfile(profileData);
  };

  const logout = async () => {
    await signOut(auth);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
