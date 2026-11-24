import {
  setPersistence,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInAnonymously,
  linkWithCredential,
  EmailAuthProvider,
  GoogleAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import {
  getFirebaseServices,
  isFirebaseConfigured,
  isRtdbConfigured,
  SIM_CHANNEL_NAME,
  OperationType,
  handleFirestoreError,
  testFirestoreConnection,
} from './firebaseConfig.js';

// Excludes visually confusing characters 0, O, 1, I
export const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SIM_USERS_KEY = 'arcane_royale_sim_users_v1';
const SIM_SESSION_KEY = 'arcane_royale_sim_session_v1';
const SIM_CODES_KEY = 'arcane_royale_sim_friendcodes_v1';

export function generateFriendCode(rng = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(rng() * FRIEND_CODE_ALPHABET.length) % FRIEND_CODE_ALPHABET.length;
    code += FRIEND_CODE_ALPHABET[idx];
  }
  return `ARC-${code}`;
}

export function validateChampionName(raw) {
  const cleaned = String(raw || '').trim().replace(/[^a-zA-Z0-9_]/g, '');
  if (cleaned.length < 3 || cleaned.length > 12) {
    return { valid: false, cleaned: cleaned.slice(0, 12), error: 'Champion Name must be 3–12 letters, numbers, or underscores.' };
  }
  return { valid: true, cleaned, error: null };
}

export function sanitizeChampionId(raw) {
  if (raw === 'TIDECALLER' || raw === 'MAGE') return 'TIDECALLER';
  if (raw === 'SHADOW' || raw === 'ASSASSIN') return 'SHADOW';
  return 'BERSERKER';
}

export function sanitizeUnlockedChampions(raw) {
  const list = Array.isArray(raw) ? raw.map(sanitizeChampionId) : [];
  const unique = Array.from(new Set(list));
  if (!unique.includes('BERSERKER')) unique.unshift('BERSERKER');
  return unique.slice(0, 5);
}

export function mergeProfileConflict(localProfile, remoteProfile) {
  if (!remoteProfile || typeof remoteProfile !== 'object') return { ...localProfile };
  if (!localProfile || typeof localProfile !== 'object') return { ...remoteProfile };

  const localUpdated = Number(localProfile.updatedAtMs || 0);
  const remoteUpdated = Number(remoteProfile.updatedAtMs || 0);
  const localScore = (Number(localProfile.level) || 1) * 100000 + (Number(localProfile.xp) || 0);
  const remoteScore = (Number(remoteProfile.level) || 1) * 100000 + (Number(remoteProfile.xp) || 0);
  const preferRemote = remoteScore > localScore || (remoteScore === localScore && remoteUpdated > localUpdated);

  const lc = localProfile.careerStats || {};
  const rc = remoteProfile.careerStats || {};

  const lt = localProfile.statTiers || {};
  const rt = remoteProfile.statTiers || {};
  const mergedStatTiers = {};
  const allStatKeys = new Set(['PWR', 'FOC', 'AGI', 'VIT', ...Object.keys(lt), ...Object.keys(rt)]);
  for (const k of allStatKeys) {
    mergedStatTiers[k] = Math.max(Number(lt[k]) || 0, Number(rt[k]) || 0);
  }

  const localLevel = Number(localProfile.level) || 1;
  const remoteLevel = Number(remoteProfile.level) || 1;
  const mergedLevel = Math.max(localLevel, remoteLevel);
  const mergedXp =
    localLevel === remoteLevel
      ? Math.max(Number(localProfile.xp) || 0, Number(remoteProfile.xp) || 0)
      : remoteLevel > localLevel
        ? Number(remoteProfile.xp) || 0
        : Number(localProfile.xp) || 0;

  return {
    ...(preferRemote ? localProfile : remoteProfile),
    ...(preferRemote ? remoteProfile : localProfile),
    displayName: (preferRemote ? remoteProfile.displayName : localProfile.displayName) || localProfile.displayName || 'ArcaneHero',
    displayNameLower: String((preferRemote ? remoteProfile.displayName : localProfile.displayName) || 'arcanehero').toLowerCase(),
    friendCode: remoteProfile.friendCode || localProfile.friendCode || generateFriendCode(),
    level: mergedLevel,
    xp: mergedXp,
    coins: Math.max(Number(localProfile.coins) || 0, Number(remoteProfile.coins) || 0),
    crystals: Math.max(Number(localProfile.crystals) || 0, Number(remoteProfile.crystals) || 0),
    gems: Math.max(Number(localProfile.gems) || 0, Number(remoteProfile.gems) || 0),
    unlockedChampions: Array.from(
      new Set([
        ...sanitizeUnlockedChampions(localProfile.unlockedChampions),
        ...sanitizeUnlockedChampions(remoteProfile.unlockedChampions),
      ])
    ).slice(0, 5),
    selectedChampion: sanitizeChampionId(preferRemote ? remoteProfile.selectedChampion : localProfile.selectedChampion),
    unlockedRunes: Array.from(new Set([...(localProfile.unlockedRunes || []), ...(remoteProfile.unlockedRunes || [])])).slice(0, 12),
    equippedRune: (preferRemote ? remoteProfile.equippedRune : localProfile.equippedRune) ?? localProfile.equippedRune ?? null,
    unlockedTrails: Array.from(new Set([...(localProfile.unlockedTrails || ['DEFAULT']), ...(remoteProfile.unlockedTrails || ['DEFAULT'])])).slice(0, 12),
    equippedTrail: (preferRemote ? remoteProfile.equippedTrail : localProfile.equippedTrail) || 'DEFAULT',
    statTiers: mergedStatTiers,
    careerStats: {
      wins: Math.max(Number(lc.wins) || 0, Number(rc.wins) || 0),
      elims: Math.max(Number(lc.elims) || 0, Number(rc.elims) || 0),
      matches: Math.max(Number(lc.matches) || 0, Number(rc.matches) || 0),
      damageDealt: Math.max(Number(lc.damageDealt) || 0, Number(rc.damageDealt) || 0),
      revives: Math.max(Number(lc.revives) || 0, Number(rc.revives) || 0),
      top10: Math.max(Number(lc.top10) || 0, Number(rc.top10) || 0),
    },
    hudLayouts: {
      portrait: (preferRemote ? remoteProfile.hudLayouts?.portrait : localProfile.hudLayouts?.portrait) || localProfile.hudLayouts?.portrait || remoteProfile.hudLayouts?.portrait || null,
      landscape: (preferRemote ? remoteProfile.hudLayouts?.landscape : localProfile.hudLayouts?.landscape) || localProfile.hudLayouts?.landscape || remoteProfile.hudLayouts?.landscape || null,
    },
    updatedAtMs: Math.max(localUpdated, remoteUpdated, Date.now()),
  };
}

function readJsonStorage(key, fallback) {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Ignore storage quota errors in restricted WebViews
  }
}

function hashSimPassword(pw) {
  let h = 2166136261;
  const str = `AR_SIM_PW|${String(pw || '')}`;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return `sim_${h.toString(16)}`;
}

function createSimChannel() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(SIM_CHANNEL_NAME);
  } catch {
    return null;
  }
}

function buildDefaultUserDoc(uid, displayName, authProvider, friendCode, seedLocal = {}) {
  const safeName = validateChampionName(displayName).cleaned || `Arcane_${uid.slice(-4).toUpperCase()}`;
  const now = Date.now();
  return {
    uid,
    displayName: safeName,
    displayNameLower: safeName.toLowerCase(),
    friendCode,
    authProvider,
    isPublic: true,
    createdAtMs: now,
    updatedAtMs: now,
    level: Math.max(1, Math.min(100, Math.floor(Number(seedLocal.level) || 1))),
    xp: Math.max(0, Math.floor(Number(seedLocal.xp) || 0)),
    coins: Math.max(0, Math.floor(Number(seedLocal.coins ?? seedLocal.gold) || 0)),
    crystals: Math.max(0, Math.floor(Number(seedLocal.crystals ?? seedLocal.astralCrystals) || 0)),
    gems: Math.max(0, Math.floor(Number(seedLocal.gems) || 0)),
    unlockedChampions: sanitizeUnlockedChampions(seedLocal.unlockedChampions || seedLocal.unlockedFighters),
    selectedChampion: sanitizeChampionId(seedLocal.selectedChampion || seedLocal.selectedFighter),
    unlockedRunes: Array.isArray(seedLocal.unlockedRunes) ? seedLocal.unlockedRunes.slice(0, 12) : [],
    equippedRune: seedLocal.equippedRune || null,
    unlockedTrails: Array.isArray(seedLocal.unlockedTrails) ? seedLocal.unlockedTrails.slice(0, 12) : ['DEFAULT'],
    equippedTrail: seedLocal.equippedTrail || 'DEFAULT',
    statTiers: seedLocal.statTiers && typeof seedLocal.statTiers === 'object' ? seedLocal.statTiers : { PWR: 0, FOC: 0, AGI: 0, VIT: 0 },
    careerStats: {
      wins: Math.max(0, Math.floor(Number(seedLocal.careerStats?.wins ?? seedLocal.wins) || 0)),
      elims: Math.max(0, Math.floor(Number(seedLocal.careerStats?.elims ?? seedLocal.eliminations) || 0)),
      matches: Math.max(0, Math.floor(Number(seedLocal.careerStats?.matches ?? seedLocal.matches) || 0)),
      damageDealt: Math.max(0, Math.floor(Number(seedLocal.careerStats?.damageDealt) || 0)),
      revives: Math.max(0, Math.floor(Number(seedLocal.careerStats?.revives) || 0)),
      top10: Math.max(0, Math.floor(Number(seedLocal.careerStats?.top10) || 0)),
    },
    hudLayouts: {
      portrait: seedLocal.hudLayouts?.portrait || seedLocal.hudLayoutPortrait || null,
      landscape: seedLocal.hudLayouts?.landscape || seedLocal.hudLayoutLandscape || null,
    },
  };
}

function formatFriendlyAuthError(err) {
  const code = err?.code || '';
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') return 'Incorrect email or password.';
  if (code === 'auth/user-not-found') return 'No Arcane account found with that email.';
  if (code === 'auth/email-already-in-use') return 'That email is already linked to another account.';
  if (code === 'auth/weak-password') return 'Password must be at least 6 characters.';
  if (code === 'auth/invalid-email') return 'Please enter a valid email address.';
  if (code === 'auth/network-request-failed') return 'Network error — check your internet connection.';
  if (code === 'auth/too-many-requests') return 'Too many attempts. Please wait a moment and try again.';
  return err instanceof Error ? err.message : 'Authentication failed.';
}

function shouldFallbackToSandbox(err) {
  const code = String(err?.code || '');
  return (
    code === 'auth/operation-not-allowed' ||
    code === 'auth/admin-restricted-operation' ||
    code === 'auth/restricted-operation' ||
    code === 'auth/configuration-not-found' ||
    code === 'auth/unauthorized-domain' ||
    code === 'auth/api-key-not-valid' ||
    code === 'auth/internal-error'
  );
}

class AuthServiceImpl {
  constructor() {
    this.user = null;
    this.profile = null;
    this.ready = false;
    this.sandboxAuth = !isFirebaseConfigured();
    this.sandboxRtdb = !isRtdbConfigured();
    this.listeners = new Set();
    this.channel = createSimChannel();
    if (this.channel) {
      this.channel.onmessage = (ev) => {
        if (ev?.data?.type === 'auth:profile_updated' && this.user && ev.data.uid === this.user.uid) {
          this.profile = mergeProfileConflict(this.profile, ev.data.profile);
          this._emit();
        }
      };
    }
  }

  getState() {
    const isSandbox = this.sandboxAuth || this.sandboxRtdb;
    const provider = this.profile?.authProvider || (this.user?.isAnonymous ? 'anonymous' : 'password');
    let statusLabel = 'Cloud Setup Pending · Local Sandbox Mode';
    if (!this.sandboxAuth && this.user) {
      if (this.sandboxRtdb) {
        statusLabel = this.user.isAnonymous
          ? 'Cloud Auth (Guest) · Sandbox Squads'
          : 'Cloud Auth Connected · Sandbox Squads';
      } else {
        statusLabel = this.user.isAnonymous ? 'Cloud Sync Active (Guest)' : 'Cloud Sync Connected';
      }
    } else if (this.user && this.sandboxAuth) {
      statusLabel = 'Cloud Setup Pending · Local Sandbox Mode';
    }
    return {
      ready: this.ready,
      configured: isFirebaseConfigured(),
      rtdbConfigured: isRtdbConfigured(),
      sandboxMode: isSandbox,
      sandboxAuth: this.sandboxAuth,
      signedIn: Boolean(this.user),
      isAnonymous: Boolean(this.user?.isAnonymous),
      uid: this.user?.uid || null,
      email: this.user?.email || null,
      displayName: this.profile?.displayName || this.user?.displayName || null,
      friendCode: this.profile?.friendCode || null,
      authProvider: provider,
      profile: this.profile,
      statusLabel,
    };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.getState());
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const snap = this.getState();
    this.listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch {
        // isolate subscriber errors
      }
    });
  }

  async init() {
    const { auth } = getFirebaseServices();
    if (!auth || this.sandboxAuth) {
      this._restoreSandboxSession();
      this.ready = true;
      this._emit();
      return this.getState();
    }

    try {
      await setPersistence(auth, indexedDBLocalPersistence).catch(() =>
        setPersistence(auth, browserLocalPersistence)
      );
      testFirestoreConnection();
      // Handle Google signInWithRedirect completion on web browsers
      await getRedirectResult(auth).catch(() => null);
    } catch {
      // Ignore persistence warnings in strict incognito modes
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.ready = true;
        this._emit();
        resolve(this.getState());
      };

      onAuthStateChanged(auth, async (fbUser) => {
        if (fbUser) {
          this.sandboxAuth = false;
          this.user = {
            uid: fbUser.uid,
            email: fbUser.email || null,
            displayName: fbUser.displayName || null,
            isAnonymous: Boolean(fbUser.isAnonymous),
            providerId: fbUser.isAnonymous
              ? 'anonymous'
              : fbUser.providerData?.[0]?.providerId === 'google.com'
                ? 'google'
                : 'password',
          };
          await this._ensureCloudProfile(fbUser);
        } else {
          // If user signed into local sandbox (e.g. Email/Password disabled in console), preserve sandbox session
          const simSess = readJsonStorage(SIM_SESSION_KEY, null);
          if (simSess && simSess.uid) {
            this._restoreSandboxSession();
          } else {
            this.user = null;
            this.profile = null;
          }
        }
        done();
        this._emit();
      });

      setTimeout(done, 2500);
    });
  }

  _restoreSandboxSession() {
    const sess = readJsonStorage(SIM_SESSION_KEY, null);
    if (!sess || !sess.uid) {
      this.user = null;
      this.profile = null;
      return;
    }
    const users = readJsonStorage(SIM_USERS_KEY, {});
    const record = users[sess.uid];
    if (!record) {
      this.user = null;
      this.profile = null;
      return;
    }
    this.sandboxAuth = true;
    this.user = {
      uid: record.uid,
      email: record.email || null,
      displayName: record.profile.displayName,
      isAnonymous: record.profile.authProvider === 'anonymous',
      providerId: record.profile.authProvider,
    };
    this.profile = record.profile;
  }

  _claimSandboxFriendCode(uid, displayName) {
    const codes = readJsonStorage(SIM_CODES_KEY, {});
    for (let attempt = 0; attempt < 25; attempt++) {
      const code = generateFriendCode();
      if (!codes[code]) {
        codes[code] = { uid, displayName };
        writeJsonStorage(SIM_CODES_KEY, codes);
        return code;
      }
    }
    const fallback = `ARC-${uid.slice(-4).toUpperCase().replace(/[^A-Z2-9]/g, 'X').padEnd(4, 'X')}`;
    codes[fallback] = { uid, displayName };
    writeJsonStorage(SIM_CODES_KEY, codes);
    return fallback;
  }

  async _claimFirestoreFriendCode(db, uid, displayName) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateFriendCode();
      const codeRef = doc(db, 'friendCodes', code);
      try {
        const snap = await getDoc(codeRef);
        if (!snap.exists()) {
          await setDoc(codeRef, {
            uid,
            displayName,
            createdAt: serverTimestamp(),
          });
          return code;
        }
      } catch {
        // Fallback to next code or local code if rules deny
      }
    }
    return this._claimSandboxFriendCode(uid, displayName);
  }

  async _ensureCloudProfile(fbUser, preferredName = null, seedLocal = {}) {
    const { db } = getFirebaseServices();
    const uid = fbUser.uid;
    const provider = fbUser.isAnonymous
      ? 'anonymous'
      : fbUser.providerData?.some((p) => p.providerId === 'google.com')
        ? 'google'
        : 'password';
    const fallbackName =
      validateChampionName(preferredName || fbUser.displayName || seedLocal.displayName || '').cleaned ||
      `Arcane_${uid.slice(-4).toUpperCase()}`;

    if (!db) {
      const code = this._claimSandboxFriendCode(uid, fallbackName);
      this.profile = buildDefaultUserDoc(uid, fallbackName, provider, code, seedLocal);
      return this.profile;
    }

    const userPath = `users/${uid}`;
    const ref = doc(db, 'users', uid);
    try {
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const remote = snap.data();
        const remoteNormalized = {
          ...remote,
          displayName: remote.displayName || remote.playerName || fallbackName,
          displayNameLower: (remote.displayNameLower || remote.displayName || remote.playerName || fallbackName).toLowerCase(),
          coins: Number(remote.coins ?? remote.gold ?? 0),
          crystals: Number(remote.crystals ?? remote.astralCrystals ?? 0),
          gems: Number(remote.gems ?? 0),
          unlockedChampions: sanitizeUnlockedChampions(remote.unlockedChampions || remote.unlockedFighters),
          selectedChampion: sanitizeChampionId(remote.selectedChampion || remote.selectedFighter),
          careerStats: remote.careerStats || {
            wins: Number(remote.wins || 0),
            elims: Number(remote.eliminations || 0),
            matches: Number(remote.matches || 0),
            damageDealt: 0,
            revives: 0,
            top10: 0,
          },
          hudLayouts: remote.hudLayouts || {
            landscape: remote.hudLayoutLandscape || null,
            portrait: remote.hudLayoutPortrait || null,
          },
          friendCode: remote.friendCode || (await this._claimFirestoreFriendCode(db, uid, remote.displayName || fallbackName)),
          authProvider: remote.authProvider || provider,
        };
        this.profile = mergeProfileConflict(seedLocal.displayName ? buildDefaultUserDoc(uid, fallbackName, provider, remoteNormalized.friendCode, seedLocal) : remoteNormalized, remoteNormalized);
        return this.profile;
      }

      const friendCode = await this._claimFirestoreFriendCode(db, uid, fallbackName);
      const docData = buildDefaultUserDoc(uid, fallbackName, provider, friendCode, seedLocal);
      await setDoc(ref, {
        ...docData,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      this.profile = docData;
      return this.profile;
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.WRITE, userPath);
      } catch {
        // Keep user playable in local profile cache if Firestore rules reject during setup
        const code = this._claimSandboxFriendCode(uid, fallbackName);
        this.profile = buildDefaultUserDoc(uid, fallbackName, provider, code, seedLocal);
        return this.profile;
      }
    }
  }

  _saveSandboxAccount(uid, email, password, profile) {
    const users = readJsonStorage(SIM_USERS_KEY, {});
    users[uid] = {
      uid,
      email: email ? String(email).trim().toLowerCase() : null,
      passwordHash: password ? hashSimPassword(password) : users[uid]?.passwordHash || null,
      profile,
    };
    writeJsonStorage(SIM_USERS_KEY, users);
    writeJsonStorage(SIM_SESSION_KEY, { uid, ts: Date.now() });
    this.sandboxAuth = true;
    this.user = {
      uid,
      email: users[uid].email,
      displayName: profile.displayName,
      isAnonymous: profile.authProvider === 'anonymous',
      providerId: profile.authProvider,
    };
    this.profile = profile;
    if (this.channel) {
      this.channel.postMessage({ type: 'auth:profile_updated', uid, profile });
    }
    this._emit();
  }

  async signInWithEmail(email, password) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return { ok: false, error: 'Please enter a valid email address.' };
    if (!password || String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };

    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth) {
      try {
        const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
        this.user = {
          uid: cred.user.uid,
          email: cred.user.email,
          displayName: cred.user.displayName,
          isAnonymous: false,
          providerId: 'password',
        };
        await this._ensureCloudProfile(cred.user);
        this._emit();
        return { ok: true, state: this.getState() };
      } catch (err) {
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, error: formatFriendlyAuthError(err) };
        }
        this.sandboxAuth = true;
      }
    }

    // Local Sandbox Sign-In
    const users = readJsonStorage(SIM_USERS_KEY, {});
    const found = Object.values(users).find((u) => u.email === cleanEmail);
    if (!found) {
      return { ok: false, error: 'No local sandbox account found for that email. Switch to Create Account.' };
    }
    if (found.passwordHash && found.passwordHash !== hashSimPassword(password)) {
      return { ok: false, error: 'Incorrect email or password.' };
    }
    this._saveSandboxAccount(found.uid, found.email, null, found.profile);
    return { ok: true, sandbox: true, state: this.getState() };
  }

  async createAccount(championName, email, password, confirmPassword, seedLocal = {}) {
    const nameCheck = validateChampionName(championName);
    if (!nameCheck.valid) return { ok: false, error: nameCheck.error };
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return { ok: false, error: 'Please enter a valid email address.' };
    if (!password || String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return { ok: false, error: 'Passwords do not match.' };
    }

    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth) {
      try {
        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
        await updateProfile(cred.user, { displayName: nameCheck.cleaned }).catch(() => null);
        this.user = {
          uid: cred.user.uid,
          email: cred.user.email,
          displayName: nameCheck.cleaned,
          isAnonymous: false,
          providerId: 'password',
        };
        await this._ensureCloudProfile(cred.user, nameCheck.cleaned, seedLocal);
        this._emit();
        return { ok: true, state: this.getState() };
      } catch (err) {
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, error: formatFriendlyAuthError(err) };
        }
        this.sandboxAuth = true;
      }
    }

    // Local Sandbox Create Account
    const users = readJsonStorage(SIM_USERS_KEY, {});
    if (Object.values(users).some((u) => u.email === cleanEmail)) {
      return { ok: false, error: 'That email is already registered in this browser.' };
    }
    const uid = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const code = this._claimSandboxFriendCode(uid, nameCheck.cleaned);
    const profile = buildDefaultUserDoc(uid, nameCheck.cleaned, 'password', code, seedLocal);
    this._saveSandboxAccount(uid, cleanEmail, password, profile);
    return { ok: true, sandbox: true, state: this.getState() };
  }

  async playAsGuest(preferredName = '', seedLocal = {}) {
    const trimmed = String(preferredName || '').trim();
    let finalName = '';
    if (trimmed) {
      const check = validateChampionName(trimmed);
      if (!check.valid) return { ok: false, error: check.error };
      finalName = check.cleaned;
    } else {
      const suffix = Math.floor(1000 + Math.random() * 9000);
      finalName = `Arcane_${suffix}`;
    }

    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth) {
      try {
        const cred = await signInAnonymously(auth);
        await updateProfile(cred.user, { displayName: finalName }).catch(() => null);
        this.user = {
          uid: cred.user.uid,
          email: null,
          displayName: finalName,
          isAnonymous: true,
          providerId: 'anonymous',
        };
        await this._ensureCloudProfile(cred.user, finalName, seedLocal);
        this._emit();
        return { ok: true, state: this.getState() };
      } catch (err) {
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, error: formatFriendlyAuthError(err) };
        }
        this.sandboxAuth = true;
      }
    }

    const uid = `guest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const code = this._claimSandboxFriendCode(uid, finalName);
    const profile = buildDefaultUserDoc(uid, finalName, 'anonymous', code, seedLocal);
    this._saveSandboxAccount(uid, null, null, profile);
    return { ok: true, sandbox: true, state: this.getState() };
  }

  async signInWithGoogle(seedLocal = {}) {
    // 1. Native Android APK WebView Hook (NEVER uses signInWithPopup)
    const bridge = typeof window !== 'undefined' ? window.ArcaneNativeBridge : null;
    if (bridge && bridge.isNativeApk && typeof bridge.signInWithGoogle === 'function') {
      try {
        const nativeRes = await bridge.signInWithGoogle();
        if (nativeRes && nativeRes.ok) {
          const uid = nativeRes.uid || `apk_${Date.now().toString(36)}`;
          const name = validateChampionName(nativeRes.displayName || 'ArcaneAPK').cleaned || 'ArcaneAPK';
          const code = this._claimSandboxFriendCode(uid, name);
          const profile = buildDefaultUserDoc(uid, name, 'google', code, seedLocal);
          this._saveSandboxAccount(uid, nativeRes.email || null, null, profile);
          return { ok: true, nativeApk: true, state: this.getState() };
        }
        return { ok: false, error: nativeRes?.error || 'Google Sign-In cancelled.' };
      } catch (err) {
        return { ok: false, error: formatFriendlyAuthError(err) };
      }
    }

    // 2. Standard Web Browser: signInWithRedirect (never signInWithPopup)
    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth && typeof window !== 'undefined' && window.top === window.self) {
      try {
        const provider = new GoogleAuthProvider();
        await signInWithRedirect(auth, provider);
        return { ok: true, redirecting: true };
      } catch (err) {
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, error: formatFriendlyAuthError(err) };
        }
      }
    }

    // 3. Embedded Preview / Sandbox Safe Fallback (avoids broken iframe redirect/popup)
    const uid = `google_sim_${Date.now().toString(36)}`;
    const name = validateChampionName(seedLocal.displayName || 'ArcanePro').cleaned || 'ArcanePro';
    const code = this._claimSandboxFriendCode(uid, name);
    const profile = buildDefaultUserDoc(uid, name, 'google', code, seedLocal);
    this._saveSandboxAccount(uid, 'champion@arcane.local', null, profile);
    return {
      ok: true,
      sandbox: true,
      message: 'Signed in via Local Sandbox Preview (Native APK / live web uses Google Redirect/Bridge).',
      state: this.getState(),
    };
  }

  async sendPasswordReset(email) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return { ok: false, error: 'Enter your email address first.' };
    const { auth } = getFirebaseServices();
    if (auth && !this.sandboxAuth) {
      try {
        await sendPasswordResetEmail(auth, cleanEmail);
        return { ok: true, message: `Password reset email sent to ${cleanEmail}.` };
      } catch (err) {
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, error: formatFriendlyAuthError(err) };
        }
      }
    }
    return { ok: true, sandbox: true, message: `Sandbox mode: password reset instructions simulated for ${cleanEmail}.` };
  }

  async upgradeGuestToEmail(email, password, newName = '') {
    if (!this.user) return { ok: false, error: 'Sign in as Guest first.' };
    if (!this.user.isAnonymous) return { ok: false, error: 'Account is already permanently secured.' };
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) return { ok: false, error: 'Please enter a valid email address.' };
    if (!password || String(password).length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };

    let displayName = this.profile?.displayName || this.user.displayName || 'ArcaneHero';
    if (newName && newName.trim()) {
      const check = validateChampionName(newName);
      if (!check.valid) return { ok: false, error: check.error };
      displayName = check.cleaned;
    }

    const { auth, db } = getFirebaseServices();
    if (auth && auth.currentUser && !this.sandboxAuth) {
      try {
        const credential = EmailAuthProvider.credential(cleanEmail, password);
        const linked = await linkWithCredential(auth.currentUser, credential);
        await updateProfile(linked.user, { displayName }).catch(() => null);
        this.user = {
          uid: linked.user.uid,
          email: linked.user.email,
          displayName,
          isAnonymous: false,
          providerId: 'password',
        };
        if (this.profile) {
          this.profile = {
            ...this.profile,
            displayName,
            displayNameLower: displayName.toLowerCase(),
            authProvider: 'password',
            updatedAtMs: Date.now(),
          };
          if (db) {
            await updateDoc(doc(db, 'users', linked.user.uid), {
              displayName,
              displayNameLower: displayName.toLowerCase(),
              authProvider: 'password',
              updatedAt: serverTimestamp(),
            }).catch(() => null);
          }
        }
        this._emit();
        return { ok: true, state: this.getState() };
      } catch (err) {
        if (!shouldFallbackToSandbox(err)) {
          return { ok: false, error: formatFriendlyAuthError(err) };
        }
      }
    }

    // Local Sandbox Guest Upgrade (preserves 100% of UID, currencies, upgrades, friends, HUD layouts)
    const users = readJsonStorage(SIM_USERS_KEY, {});
    if (Object.values(users).some((u) => u.email === cleanEmail && u.uid !== this.user.uid)) {
      return { ok: false, error: 'That email is already linked to another account.' };
    }
    const upgradedProfile = {
      ...(this.profile || buildDefaultUserDoc(this.user.uid, displayName, 'password', generateFriendCode())),
      displayName,
      displayNameLower: displayName.toLowerCase(),
      authProvider: 'password',
      updatedAtMs: Date.now(),
    };
    this._saveSandboxAccount(this.user.uid, cleanEmail, password, upgradedProfile);
    return { ok: true, sandbox: true, state: this.getState() };
  }

  async signOutUser() {
    const { auth } = getFirebaseServices();
    if (auth && auth.currentUser) {
      await signOut(auth).catch(() => null);
    }
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(SIM_SESSION_KEY);
    } catch {}
    this.user = null;
    this.profile = null;
    this._emit();
    return { ok: true, state: this.getState() };
  }

  async syncProfile(localData) {
    if (!this.user) return { ok: false, error: 'Not signed in.', mode: 'local' };
    const uid = this.user.uid;
    const friendCode = this.profile?.friendCode || this._claimSandboxFriendCode(uid, localData.displayName || localData.playerName || 'ArcaneHero');
    const localNorm = buildDefaultUserDoc(
      uid,
      localData.displayName || localData.playerName || this.profile?.displayName || 'ArcaneHero',
      this.profile?.authProvider || (this.user.isAnonymous ? 'anonymous' : 'password'),
      friendCode,
      localData
    );
    const merged = mergeProfileConflict(localNorm, this.profile);
    merged.updatedAtMs = Date.now();
    this.profile = merged;

    const { db, auth } = getFirebaseServices();
    if (db && auth?.currentUser && !this.sandboxAuth) {
      const ref = doc(db, 'users', uid);
      try {
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, {
            ...merged,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          this._emit();
          return { ok: true, action: 'created', profile: merged };
        }
        const remote = snap.data();
        const finalMerged = mergeProfileConflict(merged, remote);
        this.profile = finalMerged;
        await updateDoc(ref, {
          displayName: finalMerged.displayName,
          displayNameLower: finalMerged.displayNameLower,
          level: finalMerged.level,
          xp: finalMerged.xp,
          coins: finalMerged.coins,
          crystals: finalMerged.crystals,
          gems: finalMerged.gems,
          unlockedChampions: finalMerged.unlockedChampions,
          selectedChampion: finalMerged.selectedChampion,
          unlockedRunes: finalMerged.unlockedRunes,
          equippedRune: finalMerged.equippedRune,
          unlockedTrails: finalMerged.unlockedTrails,
          equippedTrail: finalMerged.equippedTrail,
          statTiers: finalMerged.statTiers,
          careerStats: finalMerged.careerStats,
          hudLayouts: finalMerged.hudLayouts,
          isPublic: true,
          updatedAt: serverTimestamp(),
        });
        this._emit();
        return { ok: true, action: 'updated', profile: finalMerged };
      } catch (err) {
        try {
          handleFirestoreError(err, OperationType.WRITE, `users/${uid}`);
        } catch {
          // Persist locally so gameplay is never interrupted
        }
      }
    }

    // Persist in local sandbox user store (keeps Friends/Leaderboard/Reload in sync)
    this._saveSandboxAccount(uid, this.user.email, null, merged);
    return { ok: true, action: 'sandbox_saved', profile: merged };
  }
}

export const authService = new AuthServiceImpl();
