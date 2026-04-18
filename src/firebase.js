import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, serverTimestamp } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDRbIRAdA_3ndsbgBiCQia6uL1gHQx8Uv4",
  authDomain: "mathnasium-langley.firebaseapp.com",
  projectId: "mathnasium-langley",
  storageBucket: "mathnasium-langley.firebasestorage.app",
  messagingSenderId: "1007864315644",
  appId: "1:1007864315644:web:e67c4ed3fe4d083e30a179"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export { serverTimestamp };
