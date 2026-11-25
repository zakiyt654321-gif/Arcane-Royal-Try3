import { authService } from '../authService.js';
import { socialService } from '../socialService.js';
import { squadMultiplayer } from '../squadMultiplayer.js';
import { DEV_DEMO_ENABLED, runFirebaseDiagnostics } from '../firebaseConfig.js';
import firestoreRulesRaw from '../../firestore.rules?raw';
import databaseRulesRaw from '../../database.rules.json?raw';
import '../apkBridge.js';

type CloudRequestDetail = {
  id: string;
  action: string;
  payload?: Record<string, unknown>;
};

function emitBus(type: string, detail: Record<string, unknown>) {
  document.dispatchEvent(new CustomEvent(type, { detail }));
}

// Forward live state changes from Auth, Social/Squads, and Multiplayer Match over sealed document events
let lastSignedInUid: string | null = null;

authService.subscribe((state: Record<string, unknown>) => {
  emitBus('ar:cloud:state', state);
  const uid = (state.uid as string) || null;
  if (uid && uid !== lastSignedInUid) {
    lastSignedInUid = uid;
    socialService.startForUser();
  } else if (!uid && lastSignedInUid) {
    lastSignedInUid = null;
    squadMultiplayer.leaveMatch(true);
    socialService.stop();
  }
});

socialService.subscribe((snapshot: Record<string, unknown>) => {
  emitBus('ar:social:state', snapshot);
});

squadMultiplayer.subscribe((eventType: string, payload: unknown) => {
  emitBus('ar:match:event', { eventType, payload });
});

// Sealed Document Event Bridge (Zero game-state globals exposed on window)
document.addEventListener('ar:cloud:request', async (ev: Event) => {
  const custom = ev as CustomEvent<CloudRequestDetail>;
  const detail = custom.detail;
  if (!detail || !detail.id) return;
  const p = detail.payload || {};
  let result: Record<string, unknown> = { ok: false, error: 'Unknown action' };

  try {
    switch (detail.action) {
      // --- Auth & Cloud Profile ---
      case 'init':
        result = { ok: true, state: await authService.init() };
        break;
      case 'getState':
        result = { ok: true, state: authService.getState(), social: socialService.getSnapshot() };
        break;
      case 'signInEmail':
        result = (await authService.signInWithEmail(p.email, p.password)) as Record<string, unknown>;
        break;
      case 'createAccount':
        result = (await authService.createAccount(
          p.championName,
          p.email,
          p.password,
          p.confirmPassword,
          (p.seedLocal as Record<string, unknown>) || {}
        )) as Record<string, unknown>;
        break;
      case 'playAsGuest':
      case 'signInGuest':
        result = (await authService.playAsGuest(
          String(p.preferredName || ''),
          (p.seedLocal as Record<string, unknown>) || {}
        )) as Record<string, unknown>;
        break;
      case 'signInGoogle':
        result = (await authService.signInWithGoogle(
          (p.seedLocal as Record<string, unknown>) || {}
        )) as Record<string, unknown>;
        break;
      case 'sendPasswordReset':
        result = (await authService.sendPasswordReset(p.email)) as Record<string, unknown>;
        break;
      case 'upgradeGuest':
        result = (await authService.upgradeGuestToEmail(
          p.email,
          p.password,
          String(p.newName || '')
        )) as Record<string, unknown>;
        if (result.ok) await socialService.syncMemberProfile();
        break;
      case 'signOut':
        squadMultiplayer.leaveMatch(true);
        socialService.stop();
        result = (await authService.signOutUser()) as Record<string, unknown>;
        break;
      case 'syncProfile':
        result = (await authService.syncProfile(p)) as Record<string, unknown>;
        if (result.ok) await socialService.syncMemberProfile();
        break;
      case 'submitMatch': {
        const prof = (p.profile as Record<string, unknown>) || p;
        result = (await authService.syncProfile(prof)) as Record<string, unknown>;
        if (result.ok) await socialService.syncMemberProfile();
        break;
      }
      case 'updateDisplayName':
        result = (await authService.updateDisplayName(String(p.displayName || p.newName || ''))) as Record<string, unknown>;
        if (result.ok) await socialService.syncMemberProfile();
        break;
      case 'atomicSpend': {
        const currency = String(p.currency || '');
        const amt = Math.max(0, Math.floor(Number(p.amount || 0)));
        const unlockField = typeof p.unlockField === 'string' ? p.unlockField : null;
        const equipField =
          unlockField === 'unlockedChampions'
            ? 'selectedChampion'
            : unlockField === 'unlockedRunes'
              ? 'equippedRune'
              : unlockField === 'unlockedTrails'
                ? 'equippedTrail'
                : null;
        result = (await authService.spendCurrencyTransaction({
          costCoins: Number(p.costCoins || (currency === 'coins' ? amt : 0)),
          costCrystals: Number(p.costCrystals || (currency === 'crystals' ? amt : 0)),
          costGems: Number(p.costGems || (currency === 'gems' ? amt : 0)),
          costXp: Number(p.costXp || (currency === 'xp' ? amt : 0)),
          unlockField,
          unlockId: typeof p.unlockId === 'string' ? p.unlockId : null,
          equipField,
          statKey: typeof p.statKey === 'string' ? p.statKey : null,
          nextTier: p.nextTier !== undefined ? Number(p.nextTier) : null,
          patch: (p.patch as Record<string, unknown>) || {},
        })) as Record<string, unknown>;
        break;
      }
      case 'resetLocalCache':
        result = authService.resetLocalCacheAndHud() as Record<string, unknown>;
        break;
      case 'getDevFlags':
        result = { ok: true, devDemoEnabled: Boolean(DEV_DEMO_ENABLED) };
        break;
      case 'runFirebaseDiagnostics':
        result = { ok: true, diagnostics: await runFirebaseDiagnostics() };
        break;
      case 'getFirebaseRulesText':
        result = {
          ok: true,
          firestoreRules: firestoreRulesRaw,
          databaseRules: databaseRulesRaw,
        };
        break;

      // --- Friends, Presence, Leaderboard & 4-Slot Squads ---
      case 'refreshFriends':
        result = { ok: true, social: await socialService.refreshFriends() };
        break;
      case 'searchPlayer':
        result = (await socialService.searchPlayer(p.query)) as Record<string, unknown>;
        break;
      case 'sendFriendRequest':
        result = (await socialService.sendFriendRequest(p.query)) as Record<string, unknown>;
        break;
      case 'acceptFriendRequest':
        result = (await socialService.acceptFriendRequest(p.fromUid)) as Record<string, unknown>;
        break;
      case 'declineFriendRequest':
        result = (await socialService.declineFriendRequest(p.fromUid)) as Record<string, unknown>;
        break;
      case 'removeFriend':
        result = (await socialService.removeFriend(p.friendUid)) as Record<string, unknown>;
        break;
      case 'fetchLeaderboard':
        result = (await socialService.fetchLeaderboard(
          p.sortBy === 'eliminations' ? 'eliminations' : 'wins'
        )) as Record<string, unknown>;
        break;
      case 'ensureOwnSquad':
        result = { ok: true, squad: await socialService.ensureOwnSquad() };
        break;
      case 'joinSquadByCode':
        result = (await socialService.joinSquadByCode(p.code)) as Record<string, unknown>;
        break;
      case 'inviteFriend':
        result = (await socialService.inviteFriendToSquad(p.targetUid)) as Record<string, unknown>;
        break;
      case 'respondInvite':
        result = (await socialService.respondToInvite(p.squadId, Boolean(p.accept))) as Record<string, unknown>;
        break;
      case 'toggleReady':
        result = (await socialService.toggleReady()) as Record<string, unknown>;
        break;
      case 'syncChampion':
        await socialService.syncSelectedChampion(p.championId);
        result = { ok: true };
        break;
      case 'promoteLeader':
        result = (await socialService.promoteLeader(p.targetUid)) as Record<string, unknown>;
        break;
      case 'kickMember':
        result = (await socialService.kickMember(p.targetUid)) as Record<string, unknown>;
        break;
      case 'leaveSquad':
        result = (await socialService.leaveSquad(p.createFreshOwn !== false)) as Record<string, unknown>;
        break;
      case 'updatePresence':
        await socialService.updatePresence(String(p.state || 'online'));
        result = { ok: true };
        break;
      case 'setSquadPrivacy':
        result = (await socialService.setSquadPrivacy(Boolean(p.isPrivate))) as Record<string, unknown>;
        break;
      case 'addSandboxTestMate':
        result = (await socialService.addSandboxTestMate(
          String(p.name || 'NovaTide'),
          String(p.championId || 'TIDECALLER')
        )) as Record<string, unknown>;
        break;

      // --- Real-Time Friend-Squad Match Multiplayer ---
      case 'createSquadMatch': {
        const sq = socialService.currentSquad;
        const created = (await squadMultiplayer.createMatch(sq)) as Record<string, unknown>;
        if (created.ok && created.matchId) {
          await socialService.setActiveMatchId(created.matchId);
          await socialService.updatePresence('in_match');
        }
        result = created;
        break;
      }
      case 'joinSquadMatch': {
        const joined = (await squadMultiplayer.joinMatch(String(p.matchId || ''))) as Record<string, unknown>;
        if (joined.ok) {
          await socialService.updatePresence('in_match');
        }
        result = joined;
        break;
      }
      case 'pushPlayerState':
        squadMultiplayer.pushPlayerState(p.state || p, Boolean(p.force));
        result = { ok: true };
        break;
      case 'pushDropPin':
        squadMultiplayer.pushDropPin(Number(p.x || 0), Number(p.y || 0));
        result = { ok: true };
        break;
      case 'pushQuickComm':
        squadMultiplayer.pushQuickComm(String(p.commId || 'enemy'));
        result = { ok: true };
        break;
      case 'pushAoiBots':
        squadMultiplayer.pushAoiBots(
          Array.isArray(p.bots) ? p.bots : [],
          Array.isArray(p.livingHumans) ? p.livingHumans : []
        );
        result = { ok: true };
        break;
      case 'pushWorldState':
        squadMultiplayer.pushWorldState(p.worldState || p, Boolean(p.force));
        result = { ok: true };
        break;
      case 'pushIntent':
        squadMultiplayer.pushIntent(p.intent || p);
        result = { ok: true };
        break;
      case 'pushFx':
        squadMultiplayer.pushFx(p.fx || p);
        result = { ok: true };
        break;
      case 'setMatchStatus':
        await squadMultiplayer.setMatchStatus(String(p.status || 'active'));
        if (p.status === 'finished') {
          await socialService.setActiveMatchId(null);
          await socialService.updatePresence('in_squad');
        }
        result = { ok: true };
        break;
      case 'leaveSquadMatch':
        squadMultiplayer.leaveMatch(p.clearToken !== false);
        await socialService.setActiveMatchId(null);
        await socialService.updatePresence('in_squad');
        result = { ok: true };
        break;
      case 'checkReconnectToken':
        result = { ok: true, matchId: squadMultiplayer.readReconnectToken() };
        break;
    }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : 'CloudSync error' };
  }

  emitBus('ar:cloud:response', { id: detail.id, result });
});

// Initialize Auth session persistence immediately on startup
authService.init();
