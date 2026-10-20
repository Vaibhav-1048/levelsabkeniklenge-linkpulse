import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCGLCtY6USPe6Czk_zMuC-xu01IGfT4mts",
  authDomain: "learn-8fc62.firebaseapp.com",
  projectId: "learn-8fc62",
  storageBucket: "learn-8fc62.firebasestorage.app",
  messagingSenderId: "1027717574306",
  appId: "1:1027717574306:web:69df6ca5bd025ee04871fb",
  measurementId: "G-W8N6CDZDVY"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
export const signInWithGoogle = () => signInWithPopup(auth, provider);
export const logOut = () => signOut(auth);
export { onAuthStateChanged };