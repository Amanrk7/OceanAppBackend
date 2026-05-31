// game-sync-router.js
// Central dispatcher. Called after every transaction.
// Looks up the player's GameAccount for the selected game,
// then routes to the correct platform sync file.

import { syncDepositById, syncCashoutById } from './milkyway-test.js';
import { syncDeposit as rsSyncDeposit, syncCashout as rsSyncCashout } from './riversweep-sync.js';
import { syncDeposit as gvSyncDeposit, syncCashout as gvSyncCashout } from './gamevault-sync.js';

// All bonus types are "credits" on the remote side
const CREDIT_TYPES = new Set(['deposit', 'bonus', 'match_bonus', 'special_bonus', 'streak_bonus', 'referral_bonus']);

/**
 * routeSync({ prisma, userId, gameId, txType, amount })
 *
 * txType: 'deposit' | 'cashout' | 'bonus'
 * amount: positive number (always positive, txType determines direction)
 *
 * Returns: { ok: true } | { ok: true, skipped: true } | { ok: false, error: string }
 */
export async function routeSync({ prisma, userId, gameId, txType, amount }) {
  // Guard: skip if essential params missing
  if (!gameId || !userId || !amount || amount <= 0) {
    return { ok: true, skipped: true, reason: 'missing params' };
  }

  try {
    // Look up the player's linked account for this specific game
    const gameAccount = await prisma.gameAccount.findUnique({
      where: { userId_gameId: { userId: parseInt(userId), gameId } },
      include: { game: { select: { name: true, provider: true } } },
    });

    // If no GameAccount record exists, skip silently
    if (!gameAccount) {
      console.log(`[SyncRouter] No GameAccount for user=${userId} game=${gameId} — sync skipped`);
      return { ok: true, skipped: true, reason: 'no game account linked' };
    }

    if (!gameAccount.isActive) {
      return { ok: true, skipped: true, reason: 'game account inactive' };
    }

    const remoteId = gameAccount.remoteAccountId?.trim();
    if (!remoteId) {
      console.log(`[SyncRouter] GameAccount exists but remoteAccountId is empty for user=${userId} game=${gameId}`);
      return { ok: true, skipped: true, reason: 'no remoteAccountId' };
    }

    // Provider comes from the GameAccount record (set when the account is linked)
    const provider = gameAccount.provider || 'NONE';
    const isCredit = txType === 'bonus' || CREDIT_TYPES.has(txType);
    const isDebit  = txType === 'cashout';

    console.log(`[SyncRouter] ${provider} | remoteId="${remoteId}" | type=${txType} | ${isCredit ? '+' : '-'}$${amount}`);

    switch (provider) {
      case 'MILKYWAY':
        return isCredit
          ? await syncDepositById(remoteId, amount)
          : await syncCashoutById(remoteId, amount);

      case 'RIVERSWEEP':
        return isCredit
          ? await rsSyncDeposit(remoteId, amount)
          : await rsSyncCashout(remoteId, amount);

      case 'GAMEVAULT':
        return isCredit
          ? await gvSyncDeposit(remoteId, amount)
          : await gvSyncCashout(remoteId, amount);

      default:
        return { ok: true, skipped: true, reason: `unsupported provider: ${provider}` };
    }
  } catch (err) {
    console.error(`[SyncRouter] Unexpected error:`, err.message);
    return { ok: false, error: err.message };
  }
}
