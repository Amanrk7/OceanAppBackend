// auto-task-generator.js  (complete replacement)
// Changes vs original:
//  • generatePlayerFollowupTasks / generateBonusFollowupTasks accept optional storeId
//  • broadcast() calls now pass task.storeId for real-time store isolation
//  • Scheduled jobs pass storeId when called from the API endpoints

import axios from 'axios';
import { fmtTXDate, fmtTX } from './discord-notifications.js';

const PROXY_URL    = process.env.DISCORD_PROXY_URL;
const PROXY_SECRET = process.env.DISCORD_PROXY_SECRET;
const BOT_TOKEN    = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ALERTS = process.env.DISCORD_CHANNEL_ALERTS;
const CHANNEL_SHIFTS = process.env.DISCORD_CHANNEL_SHIFTS;

const PLAYER_GEN_INTERVAL_MS = 6  * 60 * 60 * 1000;
const BONUS_GEN_INTERVAL_MS  = 12 * 60 * 60 * 1000;
const STREAK_THRESHOLD = parseInt(process.env.STREAK_BONUS_THRESHOLD || '7', 10);

async function discordSendJSON(payload, channel = 'alerts') {
  if (!BOT_TOKEN || !PROXY_URL) return false;
  const channelId = channel === 'shifts' ? CHANNEL_SHIFTS : CHANNEL_ALERTS;
  if (!channelId) return false;
  try {
    await axios.post(
      PROXY_URL,
      { channelId, botToken: BOT_TOKEN, payload },
      {
        headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': PROXY_SECRET },
        timeout: 15_000,
        validateStatus: null,
      }
    );
  } catch (err) {
    console.error('discordSendJSON (auto-task):', err.message);
  }
}

let _broadcast = null;
export function setBroadcastFn(fn) { _broadcast = fn; }
// Pass storeId so only that store's SSE clients receive the event
function broadcast(type, data, storeId = null) {
  if (_broadcast) _broadcast(type, data, storeId);
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER FOLLOWUP TASKS
// storeId = null  → run for ALL stores (scheduled)
// storeId = N     → run only for store N (admin-triggered via API)
// ─────────────────────────────────────────────────────────────────────────────
export async function generatePlayerFollowupTasks(prisma, triggeredBy = 'schedule', storeId = null) {
  try {
    const now          = new Date();
    const todayStart   = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const twoDaysAgo   = new Date(todayStart); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const sevenDaysAgo = new Date(todayStart); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const playerWhere = { role: 'PLAYER' };
    if (storeId) playerWhere.storeId = storeId;

    const allPlayers = await prisma.user.findMany({
      where: playerWhere,
      select: { id: true, name: true, username: true, balance: true, tier: true, storeId: true },
    });
    if (!allPlayers.length) return { created: 0, skipped: 0 };

    const lastDeposits = await prisma.transaction.groupBy({
      by   : ['userId'],
      where: { type: 'DEPOSIT', status: 'COMPLETED', userId: { in: allPlayers.map(p => p.id) } },
      _max : { createdAt: true },
    });
    const lastDepMap = {};
    lastDeposits.forEach(r => { lastDepMap[r.userId] = r._max.createdAt; });

    const targets = [];
    for (const p of allPlayers) {
      const lastDep = lastDepMap[p.id];
      let category = null;
      if (!lastDep || lastDep < sevenDaysAgo) category = 'INACTIVE';
      else if (lastDep < twoDaysAgo)           category = 'HIGHLY_CRITICAL';
      if (category) targets.push({ ...p, category, lastDepositDate: lastDep ? fmtTXDate(lastDep) : 'Never' });
    }

    if (!targets.length) {
      console.log('✅ Player followup: no inactive/highly-critical players');
      return { created: 0, skipped: 0 };
    }

    // Only check existing tasks for the relevant store(s)
    const existingTaskWhere = { taskType: 'PLAYER_FOLLOWUP', status: { in: ['PENDING', 'IN_PROGRESS'] } };
    if (storeId) existingTaskWhere.storeId = storeId;

    const existingTasks = await prisma.task.findMany({
      where : existingTaskWhere,
      select: { id: true, notes: true },
    });
    const coveredPlayerIds = new Set();
    existingTasks.forEach(t => {
      try { const meta = JSON.parse(t.notes || '{}'); if (meta.playerId) coveredPlayerIds.add(meta.playerId); } catch (_) {}
    });

    let created = 0, skipped = 0;
    const newTasks = [];

    // Use first admin as system creator
    const systemAdmin = await prisma.user.findFirst({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, ...(storeId ? { storeAccess: { has: storeId } } : {}) },
      select: { id: true },
    }) || await prisma.user.findFirst({ where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, select: { id: true } });

    if (!systemAdmin) {
      console.warn('[auto-task] No admin found — cannot create tasks');
      return { created: 0, skipped: 0 };
    }

    for (const p of targets) {
      if (coveredPlayerIds.has(p.id)) { skipped++; continue; }

      const isHighlyCritical = p.category === 'HIGHLY_CRITICAL';
      const priority = isHighlyCritical ? 'HIGH' : 'MEDIUM';
      const emoji    = isHighlyCritical ? '🟡' : '🔴';

      const checklistItems = [
        { id: `item_${Date.now()}_${p.id}_0`, label: 'Reach out to player',              fieldKey: 'contacted',  required: true,  done: false, completedBy: null, completedAt: null },
        { id: `item_${Date.now()}_${p.id}_1`, label: 'Player responded',                  fieldKey: 'responded',  required: false, done: false, completedBy: null, completedAt: null },
        { id: `item_${Date.now()}_${p.id}_2`, label: 'Deposit received / issue resolved', fieldKey: 'resolved',   required: true,  done: false, completedBy: null, completedAt: null },
      ];

      const task = await prisma.task.create({
        data: {
          storeId     : p.storeId || 1,
          title       : `${emoji} Follow up: ${p.name} (@${p.username})`,
          description : `Player is ${p.category.replace('_', ' ')}. Last deposit: ${p.lastDepositDate}. Balance: $${parseFloat(p.balance).toFixed(2)}.`,
          taskType    : 'PLAYER_FOLLOWUP',
          priority,
          status      : 'PENDING',
          createdById : systemAdmin.id,
          assignedToId: null,
          assignToAll : true,
          checklistItems,
          notes       : JSON.stringify({
            playerId       : p.id,
            playerName     : p.name,
            username       : p.username,
            category       : p.category,
            lastDepositDate: p.lastDepositDate,
            balance        : parseFloat(p.balance),
            tier           : p.tier,
            generatedAt    : now.toISOString(),
            triggeredBy,
          }),
        },
        include: {
          createdBy : { select: { id: true, name: true, role: true } },
          assignedTo: { select: { id: true, name: true, role: true } },
        },
      });

      // ← Pass task.storeId so only that store's clients receive it
      broadcast('task_created', task, task.storeId);
      newTasks.push(task);
      created++;
    }

    if (created > 0) {
      const hcList = newTasks.filter(t => { try { return JSON.parse(t.notes).category === 'HIGHLY_CRITICAL'; } catch { return false; } });
      const inList = newTasks.filter(t => { try { return JSON.parse(t.notes).category === 'INACTIVE'; } catch { return false; } });
      const fields = [];
      if (hcList.length) fields.push({ name: `🟡 Highly Critical (${hcList.length})`, value: hcList.slice(0, 8).map(t => { const m = JSON.parse(t.notes); return `• **${m.playerName}** (@${m.username}) — Last: ${m.lastDepositDate}`; }).join('\n').slice(0, 1000), inline: false });
      if (inList.length) fields.push({ name: `🔴 Inactive (${inList.length})`,         value: inList.slice(0, 8).map(t => { const m = JSON.parse(t.notes); return `• **${m.playerName}** (@${m.username}) — Last: ${m.lastDepositDate}`; }).join('\n').slice(0, 1000), inline: false });
      await discordSendJSON({
        embeds: [{
          title      : '📋 Player Followup Tasks Generated',
          color      : 0xf59e0b,
          description: `**${created}** new followup task(s) created.${storeId ? ` (Store ${storeId})` : ''}\n${skipped} player(s) already have active tasks.`,
          fields,
          footer     : { text: `Triggered by: ${triggeredBy} · OceanBets` },
          timestamp  : now.toISOString(),
        }],
      }, 'alerts');
    }

    console.log(`📋 Player followup tasks: created=${created}, skipped=${skipped}${storeId ? ` (store ${storeId})` : ''}`);
    return { created, skipped, total: targets.length };
  } catch (err) {
    console.error('generatePlayerFollowupTasks error:', err.message);
    return { created: 0, skipped: 0, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BONUS FOLLOWUP TASKS
// storeId = null  → all stores; storeId = N → store N only
// ─────────────────────────────────────────────────────────────────────────────
export async function generateBonusFollowupTasks(prisma, triggeredBy = 'schedule', storeId = null) {
  try {
    const now = new Date();
    const created_tasks = [];
    let created = 0, skipped = 0;

    const systemAdmin = await prisma.user.findFirst({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, ...(storeId ? { storeAccess: { has: storeId } } : {}) },
      select: { id: true },
    }) || await prisma.user.findFirst({ where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, select: { id: true } });

    if (!systemAdmin) {
      console.warn('[auto-task] No admin found — cannot create bonus tasks');
      return { created: 0, skipped: 0 };
    }

    async function hasActiveTask(playerId, bonusType, taskStoreId) {
      const existing = await prisma.task.findFirst({
        where: {
          taskType: 'BONUS_FOLLOWUP',
          status  : { in: ['PENDING', 'IN_PROGRESS'] },
          notes   : { contains: `"playerId":${playerId}` },
          ...(taskStoreId ? { storeId: taskStoreId } : {}),
        },
        select: { id: true, notes: true },
      });
      if (!existing) return false;
      try { const meta = JSON.parse(existing.notes || '{}'); return meta.bonusType === bonusType; } catch { return false; }
    }

    async function createBonusTask({ player, bonusType, eligibleAmount, details, priority = 'HIGH' }) {
      if (await hasActiveTask(player.id, bonusType, player.storeId)) { skipped++; return; }

      const labels = {
        streak  : { emoji: '🔥', label: 'Streak Bonus',   desc: 'Grant streak bonus' },
        referral: { emoji: '👥', label: 'Referral Bonus', desc: 'Grant referral bonus to player and referrer' },
        match   : { emoji: '💰', label: 'Match Bonus',    desc: 'Grant match bonus for recent deposit' },
      };
      const meta = labels[bonusType] || { emoji: '🎁', label: 'Bonus', desc: 'Grant bonus' };

      const checklistItems = [
        { id: `bonus_${Date.now()}_${player.id}`, label: meta.desc, fieldKey: 'granted', required: true, done: false, completedBy: null, completedAt: null },
      ];

      const task = await prisma.task.create({
        data: {
          storeId     : player.storeId || 1,
          title       : `${meta.emoji} ${meta.label}: ${player.name} (@${player.username})`,
          description : details,
          taskType    : 'BONUS_FOLLOWUP',
          priority,
          status      : 'PENDING',
          createdById : systemAdmin.id,
          assignedToId: null,
          assignToAll : true,
          checklistItems,
          notes       : JSON.stringify({
            playerId      : player.id,
            playerName    : player.name,
            username      : player.username,
            bonusType,
            bonusLabel    : meta.label,
            eligibleAmount,
            details,
            generatedAt   : now.toISOString(),
            triggeredBy,
          }),
        },
        include: {
          createdBy : { select: { id: true, name: true, role: true } },
          assignedTo: { select: { id: true, name: true, role: true } },
        },
      });

      // ← Pass task.storeId for store-isolated real-time delivery
      broadcast('task_created', task, task.storeId);
      created_tasks.push(task);
      created++;
    }

    // ── A: Streak bonus eligible ──────────────────────────────
    const streakWhere = {
      role         : 'PLAYER',
      currentStreak: { gte: STREAK_THRESHOLD },
      lastPlayedDate: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
    };
    if (storeId) streakWhere.storeId = storeId;

    const streakPlayers = await prisma.user.findMany({
      where : streakWhere,
      select: { id: true, name: true, username: true, currentStreak: true, balance: true, storeId: true },
    });

    for (const p of streakPlayers) {
      const recentBonus = await prisma.transaction.findFirst({
        where: { userId: p.id, type: 'BONUS', status: 'COMPLETED', description: { contains: 'Streak Bonus' }, createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } },
      });
      if (!recentBonus) {
        await createBonusTask({
          player        : p,
          bonusType     : 'streak',
          eligibleAmount: parseFloat((p.currentStreak * 0.5).toFixed(2)),
          details       : `Player has a ${p.currentStreak}-day streak and hasn't received a streak bonus in 7 days.`,
        });
      }
    }

    // ── B: Referral bonus not granted ─────────────────────────
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const referralWhere = { role: 'PLAYER', referredBy: { not: null }, createdAt: { gte: cutoff } };
    if (storeId) referralWhere.storeId = storeId;

    const newReferredPlayers = await prisma.user.findMany({
      where  : referralWhere,
      include: { referrer: { select: { id: true, name: true, username: true, balance: true, referredBy: true, createdAt: true, storeId: true } } },
    });

    for (const p of newReferredPlayers) {
      const hasBonusTx = await prisma.transaction.findFirst({
        where: { userId: p.id, type: 'BONUS', status: 'COMPLETED', description: { contains: 'Referral Bonus' } },
      });
      if (!hasBonusTx) {
        await createBonusTask({
          player        : p,
          bonusType     : 'referral',
          eligibleAmount: null,
          details       : `This player was referred by ${p.referrer?.name || '—'} (@${p.referrer?.username || '—'}). Grant Refferal Bonus to ${p.referrer?.name || '—'} (@${p.referrer?.username || '—'}!`,
          priority      : 'HIGH',
        });
      }
    }

    // ── C: Match bonus not claimed (deposits in last 24h) ─────
    const depositWindow = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const matchDepositWhere = { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: depositWindow } };
    if (storeId) {
      // Filter deposits to only players in this store
      const storePlayers = await prisma.user.findMany({
        where: { role: 'PLAYER', storeId },
        select: { id: true },
      });
      matchDepositWhere.userId = { in: storePlayers.map(p => p.id) };
    }

    const recentDeposits = await prisma.transaction.findMany({
      where  : matchDepositWhere,
      include: { user: { select: { id: true, name: true, username: true, balance: true, storeId: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const seenMatchIds = new Set();
    for (const tx of recentDeposits) {
      if (seenMatchIds.has(tx.userId)) continue;
      seenMatchIds.add(tx.userId);

      const depDay    = new Date(tx.createdAt); depDay.setHours(0, 0, 0, 0);
      const depDayEnd = new Date(depDay); depDayEnd.setHours(23, 59, 59, 999);

      const matchBonusTx = await prisma.transaction.findFirst({
        where: { userId: tx.userId, type: 'BONUS', status: 'COMPLETED', description: { contains: 'Match Bonus' }, createdAt: { gte: depDay, lte: depDayEnd } },
      });

      if (!matchBonusTx) {
        const eligibleAmount = parseFloat((parseFloat(tx.amount) * 0.5).toFixed(2));
        await createBonusTask({
          player        : tx.user,
          bonusType     : 'match',
          eligibleAmount,
          details       : `Deposited $${parseFloat(tx.amount).toFixed(2)} at ${fmtTX(tx.createdAt)}. No match bonus (50% = $${eligibleAmount}) granted yet today.`,
          priority      : 'MEDIUM',
        });
      }
    }

    if (created > 0) {
      const byType = { streak: 0, referral: 0, match: 0 };
      created_tasks.forEach(t => { try { const m = JSON.parse(t.notes); byType[m.bonusType] = (byType[m.bonusType] || 0) + 1; } catch {} });
      const fields = [];
      if (byType.streak)   fields.push({ name: `🔥 Streak Bonuses (${byType.streak})`,   value: created_tasks.filter(t => { try { return JSON.parse(t.notes).bonusType === 'streak';   } catch { return false; } }).slice(0, 8).map(t => { const m = JSON.parse(t.notes); return `• **${m.playerName}** — ${m.details}`; }).join('\n').slice(0, 1000), inline: false });
      if (byType.referral) fields.push({ name: `👥 Referral Bonuses (${byType.referral})`, value: created_tasks.filter(t => { try { return JSON.parse(t.notes).bonusType === 'referral'; } catch { return false; } }).slice(0, 8).map(t => { const m = JSON.parse(t.notes); return `• **${m.playerName}** — ${m.details}`; }).join('\n').slice(0, 1000), inline: false });
      if (byType.match)    fields.push({ name: `💰 Match Bonuses (${byType.match})`,    value: created_tasks.filter(t => { try { return JSON.parse(t.notes).bonusType === 'match';    } catch { return false; } }).slice(0, 8).map(t => { const m = JSON.parse(t.notes); return `• **${m.playerName}** — ${m.details}`; }).join('\n').slice(0, 1000), inline: false });
      await discordSendJSON({
        embeds: [{
          title      : '🎁 Bonus Followup Tasks Generated',
          color      : 0x22c55e,
          description: `**${created}** new bonus followup task(s) need attention.${storeId ? ` (Store ${storeId})` : ''}\n${skipped} already have active tasks.`,
          fields,
          footer     : { text: `Triggered by: ${triggeredBy} · OceanBets` },
          timestamp  : now.toISOString(),
        }],
      }, 'alerts');
    }

    console.log(`🎁 Bonus followup tasks: created=${created}, skipped=${skipped}${storeId ? ` (store ${storeId})` : ''}`);
    return { created, skipped };
  } catch (err) {
    console.error('generateBonusFollowupTasks error:', err.message);
    return { created: 0, skipped: 0, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULERS
// ─────────────────────────────────────────────────────────────────────────────
export function schedulePlayerFollowupGeneration(prisma) {
  console.log('📋 Scheduling player followup task generation (every 6h)');
  // storeId = null → runs for ALL stores on the schedule
  setTimeout(() => generatePlayerFollowupTasks(prisma, 'schedule', null), 15_000);
  setInterval(() => generatePlayerFollowupTasks(prisma, 'schedule', null), PLAYER_GEN_INTERVAL_MS);
}

export function scheduleBonusFollowupGeneration(prisma) {
  console.log('🎁 Scheduling bonus followup task generation (every 12h)');
  setTimeout(() => generateBonusFollowupTasks(prisma, 'schedule', null), 30_000);
  setInterval(() => generateBonusFollowupTasks(prisma, 'schedule', null), BONUS_GEN_INTERVAL_MS);
}
