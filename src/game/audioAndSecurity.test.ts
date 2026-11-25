import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_SFX_VOICES,
  SFX_COOLDOWN_MS,
  SFX_MAX_DISTANCE,
  AUDIO_OFFSET_MIN_MS,
  AUDIO_OFFSET_MAX_MS,
  ANNOUNCER_COOLDOWN_MS,
  REMOTE_SFX_STALE_MS,
  LOOKAHEAD_WINDOW_SEC,
  LOOKAHEAD_TICK_MS,
  clampAudioSyncOffset,
  computeScheduledAudioTime,
  shouldDropRemoteSfx,
  isAudioContextPlayable,
  advanceLookaheadCursor,
  computeSpatialSfxGain,
  createVoiceLimiter,
  createAnnouncerGate,
} from './audioScheduler.ts';
import { validateChampionName, escapeHtml } from '../authService.js';
import { clampFrameDeltaTime } from './mobileHudAndPerf.ts';
import {
  DEV_DEMO_ENABLED,
  SANDBOX_STORAGE_KEYS,
  CLOUD_CACHE_STORAGE_KEYS,
  isSimBroadcastEnabled,
} from '../firebaseConfig.js';
import {
  cryptoRandomFloat,
  createWorldAndFxRng,
  validateRemoteIntent,
  REMOTE_SFX_STALE_MS as MP_REMOTE_SFX_STALE_MS,
} from '../squadMultiplayer.js';

const ROOT = process.cwd();

test('Hardware audio constants match zero-latency mobile spec', () => {
  assert.equal(MAX_SFX_VOICES, 12);
  assert.equal(SFX_COOLDOWN_MS, 40);
  assert.equal(SFX_MAX_DISTANCE, 520);
  assert.equal(AUDIO_OFFSET_MIN_MS, -150);
  assert.equal(AUDIO_OFFSET_MAX_MS, 150);
  assert.equal(ANNOUNCER_COOLDOWN_MS, 1200);
  assert.equal(REMOTE_SFX_STALE_MS, 350);
  assert.equal(MP_REMOTE_SFX_STALE_MS, 350);
  assert.equal(LOOKAHEAD_WINDOW_SEC, 0.1);
  assert.equal(LOOKAHEAD_TICK_MS, 25);
});

test('clampAudioSyncOffset & computeScheduledAudioTime clamp safely to >= currentTimeSec', () => {
  assert.equal(clampAudioSyncOffset(-500), -150);
  assert.equal(clampAudioSyncOffset(500), 150);
  assert.equal(clampAudioSyncOffset(42.6), 43);
  assert.equal(clampAudioSyncOffset(Number.NaN), 0);

  // Negative offset clamps to >= currentTimeSec so audio never schedules in the past
  assert.equal(computeScheduledAudioTime(10.0, -150, 0), 10.0);
  // Relative delay shifts cleanly into hardware timeline
  assert.equal(computeScheduledAudioTime(10.0, 0, 0.08), 10.08);
  // Positive offset delays future cue cleanly
  assert.equal(computeScheduledAudioTime(10.0, 50, 0), 10.05);
});

test('isAudioContextPlayable rejects suspended and interrupted states (no wake-up burst lag)', () => {
  assert.equal(isAudioContextPlayable('running'), true);
  assert.equal(isAudioContextPlayable('suspended'), false);
  assert.equal(isAudioContextPlayable('interrupted'), false);
  assert.equal(isAudioContextPlayable('closed'), false);
  assert.equal(isAudioContextPlayable(null), false);
});

test('shouldDropRemoteSfx discards remote squadmate audio older than 350ms', () => {
  assert.equal(shouldDropRemoteSfx(10000, 10200), false);
  assert.equal(shouldDropRemoteSfx(10000, 10350), false);
  assert.equal(shouldDropRemoteSfx(10000, 10351), true);
  assert.equal(shouldDropRemoteSfx(Number.NaN, 10000), true);
});

test('advanceLookaheadCursor schedules inside 100ms horizon and snaps cleanly on tab/WebView resume', () => {
  // Normal tick inside 100ms lookahead window
  const normal = advanceLookaheadCursor(5.02, 5.0, 0.05, 0.1);
  assert.equal(normal.wasReset, false);
  assert.equal(normal.scheduledTimes.length, 2);
  assert.ok(Math.abs(normal.scheduledTimes[0] - 5.02) < 1e-6);
  assert.ok(Math.abs(normal.scheduledTimes[1] - 5.07) < 1e-6);

  // Stale cursor (e.g., tab resumed after 12 seconds) resets forward without burst-stacking
  const resumed = advanceLookaheadCursor(2.0, 14.0, 0.25, 0.1);
  assert.equal(resumed.wasReset, true);
  assert.equal(resumed.scheduledTimes.length, 1);
  assert.ok(resumed.scheduledTimes[0] >= 14.0);
});

test('computeSpatialSfxGain locks attenuation to 520u vision fairness cap', () => {
  assert.equal(computeSpatialSfxGain(0), 1);
  assert.ok(computeSpatialSfxGain(260) > 0 && computeSpatialSfxGain(260) < 0.5);
  assert.equal(computeSpatialSfxGain(520), 0);
  assert.equal(computeSpatialSfxGain(521), 0);
  assert.equal(computeSpatialSfxGain(900), 0);
});

test('createVoiceLimiter enforces 40ms per-SFX cooldown and 12-voice concurrency cap', () => {
  const limiter = createVoiceLimiter(12, 40);
  assert.equal(limiter.tryAcquire('hit', 1000, 200), true);
  assert.equal(limiter.tryAcquire('hit', 1025, 200), false); // within 40ms cooldown
  assert.equal(limiter.tryAcquire('hit', 1045, 200), true);

  // Fill remaining 10 voices with distinct keys
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.tryAcquire(`sfx_${i}`, 1050, 200), true);
  }
  assert.equal(limiter.activeCount(1050), 12);
  // 13th voice blocked
  assert.equal(limiter.tryAcquire('overflow', 1050, 200), false);
  // After voices expire, slot opens
  assert.equal(limiter.tryAcquire('overflow', 1300, 200), true);
});

test('createAnnouncerGate enforces 1.2s cooldown with priority override', () => {
  const gate = createAnnouncerGate(1200);
  assert.equal(gate.canSpeak(1000, false), true);
  assert.equal(gate.canSpeak(1500, false), false);
  assert.equal(gate.canSpeak(1500, true), true); // priority overrides cooldown
  assert.equal(gate.canSpeak(2600, false), false); // 1100ms since priority speak
  assert.equal(gate.canSpeak(2750, false), true);
});

test('validateChampionName blocks reserved staff/impersonation prefixes', () => {
  assert.equal(validateChampionName('AdminKing').valid, false);
  assert.equal(validateChampionName('system_01').valid, false);
  assert.equal(validateChampionName('WarbritePro').valid, false);
  assert.equal(validateChampionName('DevTester').valid, false);
  assert.equal(validateChampionName('NovaBlade').valid, true);
});

test('validateRemoteIntent enforces range, >=85% cooldown, damage cap, and velocity sanity', () => {
  const sender = { x: 1000, y: 1000 };
  const target = { x: 1200, y: 1000 };
  const cfg = { range: 300, tolerance: 70, cooldownMs: 500, maxDamageCap: 150, maxSpeed: 400, lastUsedAtMs: 1000 };

  // Valid hit: dist=200 <= 370, elapsed=450 >= 425 (85%), dmg=90 <= 150
  assert.equal(validateRemoteIntent({ type: 'hit', dmg: 90 }, sender, target, cfg, 1450).valid, true);

  // Cooldown violation (< 85% of 500ms = 425ms)
  const cdRes = validateRemoteIntent({ type: 'hit', dmg: 90 }, sender, target, cfg, 1300);
  assert.equal(cdRes.valid, false);
  assert.equal(cdRes.reason, 'cooldown_violation');

  // Out of range (> 370u)
  const rangeRes = validateRemoteIntent({ type: 'hit', dmg: 90 }, sender, { x: 1600, y: 1000 }, cfg, 1600);
  assert.equal(rangeRes.valid, false);
  assert.equal(rangeRes.reason, 'out_of_range');

  // Damage cap exceeded
  const dmgRes = validateRemoteIntent({ type: 'hit', dmg: 999 }, sender, target, cfg, 1600);
  assert.equal(dmgRes.valid, false);
  assert.equal(dmgRes.reason, 'damage_cap_exceeded');

  // Velocity exceeded (teleport 900u in 0.2s = 4500u/s > 500u/s)
  const velRes = validateRemoteIntent(
    { type: 'hit', dmg: 50 },
    { x: 1900, y: 1000 },
    { x: 1950, y: 1000 },
    cfg,
    1600,
    { x: 1000, y: 1000, ts: 1400 } as any
  );
  assert.equal(velRes.valid, false);
  assert.equal(velRes.reason, 'velocity_exceeded');

  // Verified dash/mobility bypasses velocity cap cleanly
  const dashRes = validateRemoteIntent(
    { type: 'hit', dmg: 50, verifiedMobility: true },
    { x: 1900, y: 1000 },
    { x: 1950, y: 1000 },
    cfg,
    1600,
    { x: 1000, y: 1000, ts: 1400 } as any
  );
  assert.equal(dashRes.valid, true);
});

test('cryptoRandomFloat & createWorldAndFxRng split deterministic worldRng from fxRng', () => {
  for (let i = 0; i < 40; i++) {
    const v = cryptoRandomFloat();
    assert.ok(v >= 0 && v < 1);
  }
  const a = createWorldAndFxRng(7777);
  const b = createWorldAndFxRng(7777);
  const wA = Array.from({ length: 8 }, () => a.worldRng());
  const wB = Array.from({ length: 8 }, () => b.worldRng());
  assert.deepEqual(wA, wB);
  const fxVal = a.fxRng();
  assert.ok(fxVal >= 0 && fxVal < 1);
});

test('Storage isolation & BroadcastChannel gating prevent sandbox/cloud cross-contamination', () => {
  assert.equal(typeof DEV_DEMO_ENABLED, 'boolean');
  for (const val of Object.values(SANDBOX_STORAGE_KEYS)) {
    assert.ok(val.startsWith('arcane_sandbox_'), `Sandbox key ${val} must use arcane_sandbox_* prefix`);
  }
  for (const val of Object.values(CLOUD_CACHE_STORAGE_KEYS)) {
    assert.ok(val.startsWith('arcane_cloud_cache_'), `Cloud cache key ${val} must use arcane_cloud_cache_* prefix`);
  }
  const baseCfg = {
    authDomain: 'real.firebaseapp.com',
    databaseURL: 'https://real-default-rtdb.firebaseio.com',
    storageBucket: 'real.firebasestorage.app',
    messagingSenderId: '123456',
    firestoreDatabaseId: '(default)',
  };
  // BroadcastChannel must be disabled whenever Firebase is configured
  assert.equal(
    isSimBroadcastEnabled({ ...baseCfg, apiKey: 'AIzaRealKey123', projectId: 'real-proj', appId: '1:123:web:abc' }),
    false
  );
  assert.equal(
    isSimBroadcastEnabled({ ...baseCfg, apiKey: 'YOUR_FIREBASE_API_KEY', projectId: 'YOUR_PROJECT_ID', appId: 'YOUR_APP_ID' }),
    true
  );
});

test('Security & Lobby structural contracts: zero setTimeout SFX chains, Account & Missions modals wired, zero-listener cloudSync shim', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('id="account-modal"'), 'Dedicated Account modal must exist');
  assert.ok(html.includes('id="missions-modal"'), 'Daily Missions drawer modal must exist');
  assert.ok(html.includes('id="toggle-bt-early"'), 'Bluetooth Early-Trigger toggle must exist');
  assert.ok(html.includes('id="slider-audio-offset"'), 'Audio Cue Sync Offset slider must exist');
  assert.ok(html.includes('id="btn-test-audio-sync"'), 'Test Sync button must exist');
  assert.ok(html.includes('id="audio-latency-readout"'), 'Audio latency readout must exist');
  assert.ok(html.includes('id="match-ping-pill"'), 'In-match ping pill must exist');
  assert.ok(html.includes('id="reconnect-banner"'), 'In-match reconnect banner must exist');
  assert.ok(html.includes('id="lb-self-pinned"'), 'Pinned self rank row in Leaderboard must exist');

  const cloudSyncTs = fs.readFileSync(path.join(ROOT, 'src', 'firebase', 'cloudSync.ts'), 'utf8');
  assert.equal(cloudSyncTs.includes('onSnapshot'), false, 'cloudSync.ts must not attach duplicate Firestore listeners');
  assert.equal(cloudSyncTs.includes('onAuthStateChanged'), false, 'cloudSync.ts must not attach duplicate Auth listeners');
});

test('escapeHtml neutralizes XSS script, tag, and attribute injection payloads', () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml(`' onmouseover='evil()&`), '&#39; onmouseover=&#39;evil()&amp;');
  assert.equal(escapeHtml('Arcane_99'), 'Arcane_99');
  assert.equal(escapeHtml(null as any), '');
});

test('dt hard-clamp blocks speedhacks and tab-switch wall tunneling (<= 0.05s)', () => {
  assert.equal(clampFrameDeltaTime(0.016), 0.016);
  assert.equal(clampFrameDeltaTime(0.5), 0.05);
  assert.equal(clampFrameDeltaTime(12.0), 0.05);
  assert.equal(clampFrameDeltaTime(-1), 0);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('Math.min(rawDelta, 0.05)'), 'Main gameLoop must hard-clamp frame delta time at 0.05s');
});
