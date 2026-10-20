import {
  collection, getDocs, getDoc, doc, updateDoc, query, where,
  serverTimestamp, increment, runTransaction, Timestamp, writeBatch
} from "firebase/firestore";
import { db, auth, signInWithGoogle, logOut, onAuthStateChanged } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const linksBody = $("linksBody");
const formMessage = $("formMessage");

// Short link format: https://your-domain/abc123
const shortUrl = (code) => window.location.origin + "/" + encodeURIComponent(code);

// Reads the code from /abc123 (new style) or ?go=abc123 (old style, still works)
const getCode = () => {
  const q = new URLSearchParams(location.search).get("go");
  if (q) return q;
  const p = location.pathname.slice(1);
  return /^[A-Za-z0-9_-]{3,32}$/.test(p) ? p : null;
};

const RESERVED = ["assets", "api", "index", "admin"];

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch { return null; }
}

function randomCode(length = 7) {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

// Slow, salted hash of the password (PBKDF2). Returns a hex string.
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    key, 256
  );
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
}

function say(message, error = false) {
  formMessage.textContent = message;
  formMessage.classList.toggle("error", error);
}

function active(link) {
  return link.status === "active" &&
    (!link.expiresAt || link.expiresAt.toMillis() > Date.now()) &&
    (link.clickLimit == null || link.clicks < link.clickLimit);
}

async function makeCodeAvailable(code) {
  const q = query(collection(db, "links"), where("code", "==", code));
  return (await getDocs(q)).empty;
}

async function createLink(event) {
  event.preventDefault();
  $("createButton").disabled = true;
  say("Checking details…");
  try {
    if (!auth.currentUser) throw new Error("Please sign in with Google first.");

    const destination = safeUrl($("destination").value.trim());
    if (!destination) throw new Error("Enter a valid http:// or https:// destination URL.");

    let code = $("alias").value.trim();
    if (code && !/^[A-Za-z0-9_-]{3,32}$/.test(code)) {
      throw new Error("Alias must be 3–32 characters: letters, numbers, _ or -.");
    }
    if (code && RESERVED.includes(code.toLowerCase())) {
      throw new Error("That alias is reserved. Choose another.");
    }
    if (!code) {
      let attempts = 0;
      do {
        code = randomCode();
        attempts++;
        if (attempts > 8) throw new Error("Could not generate a unique code. Try again.");
      } while (!(await makeCodeAvailable(code)));
    } else if (!(await makeCodeAvailable(code))) {
      throw new Error("That alias is already taken. Choose another.");
    }

    const expiryInput = $("expiry").value;
    const expiresAt = expiryInput ? new Date(expiryInput) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) {
      throw new Error("Expiry must be a future date and time.");
    }
    const limitRaw = $("limit").value;
    const clickLimit = limitRaw ? Number(limitRaw) : null;
    if (clickLimit !== null && (!Number.isInteger(clickLimit) || clickLimit < 1)) {
      throw new Error("Click limit must be a positive whole number.");
    }

    const password = $("password").value;
    if (password && password.length < 4) {
      throw new Error("Password must be at least 4 characters.");
    }

    const linkRef = doc(collection(db, "links"));
    const linkData = {
      code,
      ownerId: auth.currentUser.uid,
      status: "active",
      clicks: 0,
      clickLimit,
      expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
      createdAt: serverTimestamp()
    };

    const batch = writeBatch(db);
    if (password) {
      // Protected: destination is NOT stored in the public link document
      const salt = randomSalt();
      const hash = await hashPassword(password, salt);
      batch.set(linkRef, { ...linkData, protected: true, salt });
      batch.set(doc(db, "linkSecrets", linkRef.id + "_" + hash), {
        destination: destination.href,
        ownerId: auth.currentUser.uid
      });
    } else {
      batch.set(linkRef, { ...linkData, protected: false, destination: destination.href });
    }
    await batch.commit();

    $("linkForm").reset();
    say("Link created: " + shortUrl(code) + (password ? "  (password protected)" : ""));
    await loadLinks();
  } catch (error) {
    console.error(error);
    say(error.message || "Could not create link. Check Firebase setup and rules.", true);
  } finally {
    $("createButton").disabled = false;
  }
}

async function loadLinks() {
  try {
    if (!auth.currentUser) return;
    const q = query(
      collection(db, "links"),
      where("ownerId", "==", auth.currentUser.uid)
    );
    const snapshot = await getDocs(q);
    const rows = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => {
      const ta = a.createdAt?.toMillis?.() || 0;
      const tb = b.createdAt?.toMillis?.() || 0;
      return tb - ta;
    });

    $("totalLinks").textContent = rows.length;
    $("totalClicks").textContent = rows.reduce((sum, x) => sum + (x.clicks || 0), 0);
    $("activeLinks").textContent = rows.filter(active).length;

    if (!rows.length) {
      linksBody.innerHTML = '<tr><td colspan="5" class="empty">No links yet. Create your first one above.</td></tr>';
      return;
    }
    linksBody.replaceChildren();
    for (const link of rows) {
      const tr = document.createElement("tr");
      const shortCell = document.createElement("td");
      const a = document.createElement("a");
      a.href = shortUrl(link.code);
      a.textContent = location.host + "/" + link.code;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      shortCell.append(a);

      const dest = document.createElement("td");
      dest.className = "destination";
      dest.textContent = link.protected ? "🔒 Password protected" : link.destination;

      const clicks = document.createElement("td");
      clicks.textContent = link.clicks || 0;

      const statusCell = document.createElement("td");
      const tag = document.createElement("span");
      const isActive = active(link);
      tag.className = "tag" + (isActive ? "" : " inactive");
      tag.textContent = isActive ? "Active" : (link.status === "disabled" ? "Disabled" : "Expired / limit reached");
      statusCell.append(tag);

      const actionCell = document.createElement("td");
      if (link.status !== "disabled") {
        const button = document.createElement("button");
        button.className = "secondary-btn";
        button.type = "button";
        button.textContent = "Disable";
        button.addEventListener("click", () => disableLink(link.id));
        actionCell.append(button);
      }
      tr.append(shortCell, dest, clicks, statusCell, actionCell);
      linksBody.append(tr);
    }
  } catch (error) {
    console.error(error);
    linksBody.innerHTML = '<tr><td colspan="5" class="empty">Could not load links. Check Authentication, Firestore and Security Rules.</td></tr>';
  }
}

async function disableLink(id) {
  try {
    await updateDoc(doc(db, "links", id), { status: "disabled" });
    await loadLinks();
  } catch (error) {
    console.error(error);
    alert("Could not disable link. Check Firestore Security Rules.");
  }
}

// Shows a password box and resolves with the destination once the password is correct
function askPassword(linkId, link, msg) {
  return new Promise((resolve) => {
    const box = document.getElementById("pwBox");
    msg.textContent = "🔒 This link is password protected.";
    box.innerHTML =
      '<form id="pwForm" style="display:flex;gap:10px;max-width:420px;margin-top:16px">' +
      '<input id="pwInput" type="password" placeholder="Enter password" required ' +
      'style="flex:1;padding:12px;border-radius:8px;border:1px solid #34415e;background:#0b1222;color:white">' +
      '<button id="pwBtn" type="submit" style="padding:12px 18px;border:0;border-radius:8px;background:#a4f56d;color:#101928;font-weight:700;cursor:pointer">Unlock</button>' +
      '</form>';
    const input = document.getElementById("pwInput");
    const btn = document.getElementById("pwBtn");
    document.getElementById("pwForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true;
      msg.textContent = "Checking…";
      try {
        const hash = await hashPassword(input.value, link.salt);
        const snap = await getDoc(doc(db, "linkSecrets", linkId + "_" + hash));
        if (snap.exists()) {
          box.innerHTML = "";
          msg.textContent = "Opening…";
          resolve(snap.data().destination);
          return;
        }
        msg.textContent = "Wrong password. Try again.";
      } catch (err) {
        console.error(err);
        msg.textContent = "Wrong password. Try again.";
      }
      input.value = "";
      btn.disabled = false;
      input.focus();
    });
    input.focus();
  });
}

async function handleRedirect() {
  const code = getCode();
  if (!code) return;
  document.body.innerHTML =
    '<main style="font:16px sans-serif;padding:40px;background:#0b1020;color:white;min-height:100vh">' +
    '<h2>Opening link…</h2><p id="redirectMessage">Checking link status.</p><div id="pwBox"></div></main>';
  const msg = document.getElementById("redirectMessage");
  try {
    const q = query(collection(db, "links"), where("code", "==", code));
    const snapshot = await getDocs(q);
    if (snapshot.empty) throw new Error("This short link does not exist.");
    const found = snapshot.docs[0];
    const link = found.data();
    if (!active(link)) throw new Error("This link is expired, disabled, or has reached its click limit.");

    let destination = link.destination;
    if (link.protected) {
      destination = await askPassword(found.id, link, msg);
    }

    // Atomic update reduces race conditions, but browser-side rules are not tamper-proof.
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "links", found.id);
      const fresh = await tx.get(ref);
      if (!fresh.exists() || !active(fresh.data())) throw new Error("This link is no longer active.");
      tx.update(ref, { clicks: increment(1) });
      tx.set(doc(collection(db, "clickEvents")), {
        linkId: found.id,
        code,
        clickedAt: serverTimestamp(),
        referrer: document.referrer || "",
        userAgent: navigator.userAgent
      });
    });
    window.location.replace(destination);
  } catch (error) {
    console.error(error);
    if (msg) msg.textContent = error.message || "Unable to open this link.";
  }
}

if (getCode()) {
  // Visitors opening a short link do not need to sign in
  handleRedirect();
} else {
  $("linkForm").addEventListener("submit", createLink);
  $("refreshButton").addEventListener("click", loadLinks);
  $("authButton").addEventListener("click", () => {
    if (auth.currentUser) logOut();
    else signInWithGoogle().catch(e => say(e.message, true));
  });

  onAuthStateChanged(auth, (user) => {
    $("connection").textContent = user ? (user.displayName || user.email) : "Signed out";
    $("authButton").textContent = user ? "Sign out" : "Sign in with Google";
    if (user) {
      loadLinks();
    } else {
      $("totalLinks").textContent = "—";
      $("totalClicks").textContent = "—";
      $("activeLinks").textContent = "—";
      linksBody.innerHTML = '<tr><td colspan="5" class="empty">Sign in to see your links.</td></tr>';
    }
  });
}