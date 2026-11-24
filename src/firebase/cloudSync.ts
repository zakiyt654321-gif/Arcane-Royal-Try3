import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  linkWithPopup,
  signOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  getDocs,
  collection,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { isValidFirebaseConfig, validateMatchTelemetry, type MatchTelemetryPayload } from '../game/flagshipUpgrade';

// ==========================================
// STRUCTURED FIRESTORE ERROR HANDLER
// ==========================================
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let cloudAvailable = false;
let currentUser: User | null = null;

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid ?? null,
      email: auth?.currentUser?.email ?? null,
      emailVerified: auth?.currentUser?.emailVerified ?? null,
      isAnonymous: auth?.currentUser?.isAnonymous ?? null,
      tenantId: auth?.currentUser?.tenantId ?? null,
      providerInfo:
        auth?.currentUser?.providerData?.map(p => ({
          providerId: p.providerId,
          email: p.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function sanitizeName(raw: unknown): string {
  const cleaned = String(raw || 'HERO')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .slice(0, 12);
  return cleaned.length >= 1 ? cleaned : 'HERO';
}

function sanitizeChampion(raw: unknown): 'BERSERKER' | 'TIDECALLER' | 'SHADOW' {
  if (raw === 'TIDECALLER' || raw === 'MAGE') return 'TIDECALLER';
  if (raw === 'SHADOW' || raw === 'ASSASSIN') return 'SHADOW';
  return 'BERSERKER';
}

function sanitizeUnlocked(raw: unknown): string[] {
  const mapped = Array.isArray(raw) ? raw.map(v => sanitizeChampion(v)) : [];
  const arr = Array.from(new Set(mapped));
  if (!arr.includes('BERSERKER')) arr.unshift('BERSERKER');
  return arr.slice(0, 5);
}

function sanitizeHudLayoutForCloud(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {
    version: 1,
    snapToGrid: Boolean(obj.snapToGrid),
  };
  if (obj.elements && typeof obj.elements === 'object') {
    const els = obj.elements as Record<string, Record<string, unknown>>;
    const safeEls: Record<string, unknown> = {};
    for (const k of ['joystick', 'actions', 'quickuse', 'resources', 'minimap']) {
      if (els[k] && typeof els[k] === 'object') {
        safeEls[k] = {
          x: typeof els[k].x === 'number' ? els[k].x : null,
          y: typeof els[k].y === 'number' ? els[k].y : null,
          scale: typeof els[k].scale === 'number' ? els[k].scale : 1,
          opacity: typeof els[k].opacity === 'number' ? els[k].opacity : 1,
        };
      }
    }
    out.elements = safeEls;
  }
  return out;
}

function emitCloudEvent(type: string, detail: Record<string, unknown>) {
  document.dispatchEvent(new CustomEvent(type, { detail }));
}

function broadcastState() {
  emitCloudEvent('ar:cloud:state', {
    configured: cloudAvailable,
    signedIn: Boolean(currentUser),
    isAnonymous: Boolean(currentUser?.isAnonymous),
    uid: currentUser?.uid ?? null,
    displayName: currentUser?.displayName ?? null,
    email: currentUser?.email ?? null,
    statusLabel: currentUser
      ? currentUser.isAnonymous
        ? 'Cloud Sync Active (Guest)'
        : 'Cloud Sync Connected (Google)'
      : 'Local Save Mode · Cloud Ready',
  });
}

async function testConnection() {
  if (!db) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

function initFirebaseSafe() {
  if (!isValidFirebaseConfig(firebaseConfig)) {
    cloudAvailable = false;
    broadcastState();
    return;
  }
  try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
    auth = getAuth(app);
    cloudAvailable = true;
    testConnection();
    onAuthStateChanged(auth, user => {
      currentUser = user;
      broadcastState();
    });
  } catch {
    cloudAvailable = false;
    broadcastState();
  }
}

async function signInGoogle(): Promise<Record<string, unknown>> {
  if (!cloudAvailable || !auth) {
    return { ok: false, fallback: true, message: 'Local Save Mode · Cloud Ready' };
  }
  const provider = new GoogleAuthProvider();
  try {
    if (auth.currentUser && auth.currentUser.isAnonymous) {
      try {
        const linked = await linkWithPopup(auth.currentUser, provider);
        currentUser = linked.user;
      } catch {
        const cred = await signInWithPopup(auth, provider);
        currentUser = cred.user;
      }
    } else {
      const cred = await signInWithPopup(auth, provider);
      currentUser = cred.user;
    }
    broadcastState();
    return { ok: true, uid: currentUser?.uid, displayName: currentUser?.displayName };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Sign-in cancelled.' };
  }
}

async function signInGuest(): Promise<Record<string, unknown>> {
  if (!cloudAvailable || !auth) {
    return { ok: false, fallback: true, message: 'Local Save Mode · Cloud Ready' };
  }
  try {
    const cred = await signInAnonymously(auth);
    currentUser = cred.user;
    broadcastState();
    return { ok: true, uid: currentUser?.uid, isAnonymous: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Anonymous Guest sign-in is disabled on this project.',
    };
  }
}

async function signOutUser(): Promise<Record<string, unknown>> {
  if (!cloudAvailable || !auth) return { ok: true };
  try {
    await signOut(auth);
    currentUser = null;
    broadcastState();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Sign-out failed.' };
  }
}

async function syncProfile(profile: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!cloudAvailable || !db || !auth?.currentUser) {
    return { ok: false, fallback: true, mode: 'local' };
  }
  const uid = auth.currentUser.uid;
  const userPath = `users/${uid}`;
  const ref = doc(db, 'users', uid);

  try {
    const snap = await getDoc(ref);
    const localWins = Math.max(0, Math.min(1000000, Math.floor(Number(profile.wins) || 0)));
    const localElims = Math.max(0, Math.min(5000000, Math.floor(Number(profile.eliminations) || 0)));
    const localMatches = Math.max(0, Math.min(1000000, Math.floor(Number(profile.matches) || 0)));
    const localLevel = Math.max(1, Math.min(100, Math.floor(Number(profile.level) || 1)));

    const payload: Record<string, unknown> = {
      uid,
      playerName: sanitizeName(profile.playerName),
      level: localLevel,
      xp: Math.max(0, Math.min(10000000, Math.floor(Number(profile.xp) || 0))),
      gold: Math.max(0, Math.min(999999999, Math.floor(Number(profile.gold) || 0))),
      astralCrystals: Math.max(0, Math.min(999999999, Math.floor(Number(profile.astralCrystals) || 0))),
      gems: Math.max(0, Math.min(999999999, Math.floor(Number(profile.gems) || 0))),
      selectedFighter: sanitizeChampion(profile.selectedFighter),
      unlockedFighters: sanitizeUnlocked(profile.unlockedFighters),
      wins: localWins,
      eliminations: localElims,
      matches: localMatches,
      saveDigest: String(profile.saveDigest || 'AR_LOCAL').slice(0, 64),
      updatedAt: serverTimestamp(),
    };
    const hudLand = sanitizeHudLayoutForCloud(profile.hudLayoutLandscape);
    const hudPort = sanitizeHudLayoutForCloud(profile.hudLayoutPortrait);
    if (hudLand) payload.hudLayoutLandscape = hudLand;
    if (hudPort) payload.hudLayoutPortrait = hudPort;

    if (!snap.exists()) {
      await setDoc(ref, { ...payload, createdAt: serverTimestamp() });
      return { ok: true, action: 'created' };
    }

    const remote = snap.data();
    // Server-wins conflict merge if remote is strictly ahead in progression
    if ((remote.level || 1) > localLevel || (remote.matches || 0) > localMatches) {
      return { ok: true, action: 'pulled', remoteProfile: remote };
    }

    // Clamp update deltas strictly within Firestore rule bounds
    const boundedUpdate: Record<string, unknown> = {
      playerName: payload.playerName,
      level: Math.min((remote.level || 1) + 25, Math.max(remote.level || 1, localLevel)),
      xp: payload.xp,
      gold: Math.min((remote.gold || 0) + 50000, payload.gold as number),
      astralCrystals: Math.min((remote.astralCrystals || 0) + 50000, payload.astralCrystals as number),
      gems: Math.min((remote.gems || 0) + 10000, payload.gems as number),
      selectedFighter: payload.selectedFighter,
      unlockedFighters: payload.unlockedFighters,
      wins: Math.min((remote.wins || 0) + 1, Math.max(remote.wins || 0, localWins)),
      eliminations: Math.min((remote.eliminations || 0) + 49, Math.max(remote.eliminations || 0, localElims)),
      matches: Math.min((remote.matches || 0) + 1, Math.max(remote.matches || 0, localMatches)),
      saveDigest: payload.saveDigest,
      updatedAt: serverTimestamp(),
    };
    if (hudLand) boundedUpdate.hudLayoutLandscape = hudLand;
    if (hudPort) boundedUpdate.hudLayoutPortrait = hudPort;

    await updateDoc(ref, boundedUpdate);
    return { ok: true, action: 'updated' };
  } catch (error) {
    try {
      handleFirestoreError(error, OperationType.WRITE, userPath);
    } catch (wrapped) {
      return { ok: false, error: wrapped instanceof Error ? wrapped.message : 'Sync failed' };
    }
  }
}

async function submitMatchLeaderboard(
  profile: Record<string, unknown>,
  telemetry: MatchTelemetryPayload
): Promise<Record<string, unknown>> {
  const check = validateMatchTelemetry(telemetry);
  if (!check.valid) {
    return { ok: false, rejected: true, reason: check.reason };
  }
  if (!cloudAvailable || !db || !auth?.currentUser) {
    return { ok: true, localOnly: true, digest: check.digest };
  }
  const uid = auth.currentUser.uid;
  const lbPath = `leaderboard/${uid}`;
  const ref = doc(db, 'leaderboard', uid);

  try {
    const snap = await getDoc(ref);
    const localWins = Math.max(0, Math.min(1000000, Math.floor(Number(profile.wins) || 0)));
    const localElims = Math.max(0, Math.min(5000000, Math.floor(Number(profile.eliminations) || 0)));
    const localMatches = Math.max(0, Math.min(1000000, Math.floor(Number(profile.matches) || 0)));
    const localLevel = Math.max(1, Math.min(100, Math.floor(Number(profile.level) || 1)));

    const basePayload = {
      uid,
      playerName: sanitizeName(profile.playerName),
      champion: sanitizeChampion(telemetry.champion),
      level: localLevel,
      wins: localWins,
      eliminations: localElims,
      matches: localMatches,
      isPublic: true,
      lastMatchDurationSec: Math.max(5, Math.min(1800, Number(telemetry.durationSec))),
      lastMatchKills: Math.max(0, Math.min(49, Math.floor(telemetry.kills))),
      lastMatchMaxDps: Math.max(0, Math.min(2500, Number(telemetry.maxDps))),
      telemetryDigest: check.digest,
      updatedAt: serverTimestamp(),
    };

    if (!snap.exists()) {
      await setDoc(ref, { ...basePayload, createdAt: serverTimestamp() });
    } else {
      const existing = snap.data();
      await updateDoc(ref, {
        playerName: basePayload.playerName,
        champion: basePayload.champion,
        level: Math.min((existing.level || 1) + 25, Math.max(existing.level || 1, localLevel)),
        wins: Math.min((existing.wins || 0) + 1, Math.max(existing.wins || 0, localWins)),
        eliminations: Math.min((existing.eliminations || 0) + 49, Math.max(existing.eliminations || 0, localElims)),
        matches: Math.min((existing.matches || 0) + 1, Math.max(existing.matches || 0, localMatches)),
        isPublic: true,
        lastMatchDurationSec: basePayload.lastMatchDurationSec,
        lastMatchKills: basePayload.lastMatchKills,
        lastMatchMaxDps: basePayload.lastMatchMaxDps,
        telemetryDigest: check.digest,
        updatedAt: serverTimestamp(),
      });
    }
    return { ok: true, digest: check.digest };
  } catch (error) {
    try {
      handleFirestoreError(error, OperationType.WRITE, lbPath);
    } catch (wrapped) {
      return { ok: false, error: wrapped instanceof Error ? wrapped.message : 'Leaderboard submit failed' };
    }
  }
}

async function fetchLeaderboard(sortBy: 'wins' | 'eliminations' = 'wins'): Promise<Record<string, unknown>> {
  if (!cloudAvailable || !db || !auth?.currentUser) {
    return { ok: true, source: 'local', entries: [] };
  }
  const lbPath = 'leaderboard';
  try {
    const q = query(
      collection(db, lbPath),
      where('isPublic', '==', true),
      orderBy(sortBy === 'eliminations' ? 'eliminations' : 'wins', 'desc'),
      limit(50)
    );
    const snap = await getDocs(q);
    const entries = snap.docs.map(d => {
      const data = d.data();
      return {
        uid: String(data.uid || d.id),
        playerName: String(data.playerName || 'CHAMPION'),
        champion: sanitizeChampion(data.champion),
        level: Number(data.level || 1),
        wins: Number(data.wins || 0),
        eliminations: Number(data.eliminations || 0),
        matches: Number(data.matches || 1),
      };
    });
    return { ok: true, source: 'cloud', entries };
  } catch (error) {
    try {
      handleFirestoreError(error, OperationType.LIST, lbPath);
    } catch {
      return { ok: true, source: 'local', entries: [] };
    }
  }
}

// Sealed Document Event Bridge (Exposes ZERO properties on window)
document.addEventListener('ar:cloud:request', async (ev: Event) => {
  const custom = ev as CustomEvent<{ id: string; action: string; payload?: Record<string, unknown> }>;
  const detail = custom.detail;
  if (!detail || !detail.id) return;
  let result: Record<string, unknown> = { ok: false, error: 'Unknown action' };
  try {
    switch (detail.action) {
      case 'getState':
        broadcastState();
        result = { ok: true };
        break;
      case 'signInGoogle':
        result = await signInGoogle();
        break;
      case 'signInGuest':
        result = await signInGuest();
        break;
      case 'signOut':
        result = await signOutUser();
        break;
      case 'syncProfile':
        result = await syncProfile(detail.payload || {});
        break;
      case 'submitMatch':
        result = await submitMatchLeaderboard(
          (detail.payload?.profile as Record<string, unknown>) || {},
          detail.payload?.telemetry as MatchTelemetryPayload
        );
        break;
      case 'fetchLeaderboard':
        result = await fetchLeaderboard(
          detail.payload?.sortBy === 'eliminations' ? 'eliminations' : 'wins'
        );
        break;
    }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : 'CloudSync error' };
  }
  emitCloudEvent('ar:cloud:response', { id: detail.id, result });
});

initFirebaseSafe();
