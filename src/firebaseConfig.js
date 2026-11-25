import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import { getDatabase } from 'firebase/database';
import appletConfig from '../firebase-applet-config.json';

/**
 * Single Firebase configuration hub for Arcane Royale.
 * Replace placeholder keys below (or update firebase-applet-config.json) with your
 * Firebase project credentials to enable Live Cloud Mode across Auth, Firestore, and RTDB.
 * When placeholder values or an empty databaseURL are detected, Arcane Royale seamlessly
 * runs in Local Auth & Squad Simulator Mode (localStorage + BroadcastChannel) without blocking.
 */
export const FIREBASE_CONFIG = {
  apiKey: appletConfig.apiKey || 'YOUR_FIREBASE_API_KEY',
  authDomain: appletConfig.authDomain || 'YOUR_PROJECT_ID.firebaseapp.com',
  // Set your Firebase Realtime Database URL (e.g. "https://your-project-default-rtdb.firebaseio.com")
  // to activate live cross-device Presence, 4-Slot Squad Rooms, and Real-Time Squad Matches:
  databaseURL: appletConfig.databaseURL || 'YOUR_FIREBASE_DATABASE_URL',
  projectId: appletConfig.projectId || 'YOUR_PROJECT_ID',
  storageBucket: appletConfig.storageBucket || 'YOUR_PROJECT_ID.firebasestorage.app',
  messagingSenderId: appletConfig.messagingSenderId || 'YOUR_MESSAGING_SENDER_ID',
  appId: appletConfig.appId || 'YOUR_FIREBASE_APP_ID',
  firestoreDatabaseId: appletConfig.firestoreDatabaseId || '(default)',
};

export const SIM_CHANNEL_NAME = 'arcane_royale_sim';
export const DEV_DEMO_ENABLED = true;

export const SANDBOX_STORAGE_KEYS = Object.freeze({
  users: 'arcane_sandbox_users_v1',
  session: 'arcane_sandbox_session_v1',
  friendCodes: 'arcane_sandbox_friendcodes_v1',
  friends: 'arcane_sandbox_friends_v1',
  requests: 'arcane_sandbox_requests_v1',
  presence: 'arcane_sandbox_presence_v1',
  squads: 'arcane_sandbox_squads_v1',
  invites: 'arcane_sandbox_invites_v1',
  matches: 'arcane_sandbox_matches_v1',
});

export const CLOUD_CACHE_STORAGE_KEYS = Object.freeze({
  profile: 'arcane_cloud_cache_profile_v1',
  meta: 'arcane_cloud_cache_meta_v1',
});

export const OperationType = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
});

const PLACEHOLDER_RE = /your_|placeholder|remixed-project-id|xxxx|replace_me/i;

export function isFirebaseConfigured(cfg = FIREBASE_CONFIG) {
  if (!cfg || typeof cfg !== 'object') return false;
  const apiKey = String(cfg.apiKey || '').trim();
  const projectId = String(cfg.projectId || '').trim();
  const appId = String(cfg.appId || '').trim();
  if (!apiKey || !projectId || !appId) return false;
  if (PLACEHOLDER_RE.test(apiKey) || PLACEHOLDER_RE.test(projectId) || PLACEHOLDER_RE.test(appId)) {
    return false;
  }
  return true;
}

export function isRtdbConfigured(cfg = FIREBASE_CONFIG) {
  if (!isFirebaseConfigured(cfg)) return false;
  const url = String(cfg.databaseURL || '').trim();
  if (!url || PLACEHOLDER_RE.test(url)) return false;
  return /^https:\/\/[a-z0-9.-]+(firebaseio\.com|firebasedatabase\.app)\/?$/i.test(url);
}

export function isSandboxMode(cfg = FIREBASE_CONFIG) {
  return !isFirebaseConfigured(cfg) || !isRtdbConfigured(cfg);
}

export function isSimBroadcastEnabled(cfg = FIREBASE_CONFIG) {
  return !isFirebaseConfigured(cfg);
}

let cachedServices = null;

export function getFirebaseServices() {
  if (cachedServices) return cachedServices;
  if (!isFirebaseConfigured(FIREBASE_CONFIG)) {
    cachedServices = { app: null, auth: null, db: null, rtdb: null, liveFirestore: false, liveRtdb: false };
    return cachedServices;
  }
  try {
    const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
    const auth = getAuth(app);
    const db =
      FIREBASE_CONFIG.firestoreDatabaseId && FIREBASE_CONFIG.firestoreDatabaseId !== '(default)'
        ? getFirestore(app, FIREBASE_CONFIG.firestoreDatabaseId)
        : getFirestore(app);
    let rtdb = null;
    if (isRtdbConfigured(FIREBASE_CONFIG)) {
      try {
        rtdb = getDatabase(app, FIREBASE_CONFIG.databaseURL);
      } catch {
        rtdb = null;
      }
    }
    cachedServices = {
      app,
      auth,
      db,
      rtdb,
      liveFirestore: Boolean(db),
      liveRtdb: Boolean(rtdb),
    };
    return cachedServices;
  } catch {
    cachedServices = { app: null, auth: null, db: null, rtdb: null, liveFirestore: false, liveRtdb: false };
    return cachedServices;
  }
}

export async function testFirestoreConnection() {
  const { db } = getFirebaseServices();
  if (!db) return false;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
    return false;
  }
}

export function handleFirestoreError(error, operationType, path) {
  const { auth } = getFirebaseServices();
  const user = auth?.currentUser || null;
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: user?.uid ?? null,
      email: user?.email ?? null,
      emailVerified: user?.emailVerified ?? null,
      isAnonymous: user?.isAnonymous ?? null,
      tenantId: user?.tenantId ?? null,
      providerInfo:
        user?.providerData?.map((p) => ({
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
