# Arcane Royale Firestore Security Specification

## 1. Data Invariants
1. **Strict Ownership (`/users/{userId}`)**: Only the authenticated user whose `request.auth.uid == userId` may read, create, update, or delete their private profile document. Zero blanket `list` access is permitted on `/users`.
2. **Zero-PII Public Leaderboard (`/leaderboard/{userId}`)**: Leaderboard records contain only competitive public attributes (`uid`, `playerName`, `champion`, `level`, `wins`, `eliminations`, `matches`, `isPublic`, telemetry validation fields, and server timestamps). No email, phone, or device tokens are stored here.
3. **Anti-Tamper Bounded Progression**: Currency balances (`gold`, `astralCrystals`, `gems`), levels (`1..100`), and match increments (`wins`, `eliminations`, `matches`) are strictly bounded in type, range, and per-update delta (`wins <= existing + 1`, `eliminations <= existing + 49`, `matches <= existing + 1`, `gold <= existing + 50000`, `gems <= existing + 10000`).
4. **Immutable Identity & Server Timestamps**: `uid` and `createdAt` are immutable after document creation. `createdAt` (on create) and `updatedAt` (on create/update) must strictly equal `request.time`.
5. **Telemetry Sanity Gate**: Every leaderboard submission must include valid match telemetry bounds (`5 <= lastMatchDurationSec <= 1800`, `0 <= lastMatchKills <= 49`, `0 <= lastMatchMaxDps <= 2500`, and a non-empty `telemetryDigest`).

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Cross-User Profile Read**: Authenticated user `uid_B` calls `get(/users/uid_A)`.
2. **Cross-User Profile Write / Identity Spoof**: User `uid_B` creates `/users/uid_B` with `{ uid: "uid_A", ... }`.
3. **Blanket User Enumeration**: User `uid_A` calls `list(/users)`.
4. **Shadow / Ghost Field Injection**: User `uid_A` updates `/users/uid_A` adding `{ isAdmin: true }` or `{ role: "superadmin" }`.
5. **Currency Inflation Exploit**: User `uid_A` updates `/users/uid_A` jumping `gold` from `100` to `9999999` in a single write.
6. **Level Cap Bypass**: User `uid_A` sets `level: 999` (exceeding max `100`).
7. **Unbounded String Poisoning (DoW)**: User `uid_A` writes a 10KB `playerName` or oversized document ID (`userId` > 128 chars or invalid characters).
8. **Client Timestamp Forgery**: User `uid_A` writes a backdated/future client timestamp instead of `serverTimestamp()` (`request.time`).
9. **Immutable `createdAt` Tampering**: User `uid_A` alters `createdAt` on an update.
10. **Leaderboard Kill-Rate / Stat Jump Spoof**: User `uid_A` increments `wins` by `+50` or `eliminations` by `+200` in one leaderboard update.
11. **Impossible Telemetry Submission**: User `uid_A` submits `lastMatchMaxDps: 99999` or `lastMatchDurationSec: 0` on `/leaderboard/uid_A`.
12. **Unauthenticated Write**: Anonymous unauthenticated client (`request.auth == null`) attempts to write `/users/guest` or `/leaderboard/guest`.
