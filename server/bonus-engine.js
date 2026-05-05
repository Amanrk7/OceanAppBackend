// bonus-engine.js
// Place this file alongside server.js
// Called (fire-and-forget) after every successful deposit.

// ── Config ────────────────────────────────────────────────────────
const MILESTONE_STEP = 50;    // create a bonus record every $50 of daily deposits
const MILESTONE_BONUS = 5.00;  // $5 granted per milestone
const REFERRAL_PCT = 0.10;  // 10% of referred player's last-7-day deposits

// ── Helpers ───────────────────────────────────────────────────────
function getMondayStr(date = new Date()) {
    const d = new Date(date);
    const day = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    d.setHours(0, 0, 0, 0);
    return d.toISOString().split('T')[0];
}

function todayStr() {
    return new Date().toISOString().split('T')[0];
}

async function getSystemCreatorId(prisma) {
    const admin = await prisma.user.findFirst({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
        select: { id: true },
    });
    return admin?.id ?? null;
}

// ── 1. MILESTONE BONUS ────────────────────────────────────────────
// Call after a deposit is saved. Checks if today's cumulative deposits
// for `playerId` cross any new $50 milestones and creates records + tasks.
export async function checkMilestoneBonuses(playerId, prisma, broadcastFn) {
    try {
        const date = todayStr();
        const dayStart = new Date(`${date}T00:00:00.000Z`);
        const dayEnd = new Date(`${date}T23:59:59.999Z`);

        // Cumulative completed deposits today
        const { _sum } = await prisma.transaction.aggregate({
            where: {
                userId: playerId, type: 'DEPOSIT', status: 'COMPLETED',
                createdAt: { gte: dayStart, lte: dayEnd }
            },
            _sum: { amount: true },
        });
        const totalToday = parseFloat(_sum.amount || 0);
        if (totalToday < MILESTONE_STEP) return [];

        // All milestones covered by today's total
        const allMilestones = [];
        for (let m = MILESTONE_STEP; m <= totalToday; m += MILESTONE_STEP) allMilestones.push(m);

        // Milestones already created today (idempotency)
        const existing = await prisma.depositMilestoneBonus.findMany({
            where: { playerId, date }, select: { milestone: true },
        });
        const existingSet = new Set(existing.map(e => e.milestone));
        const newMilestones = allMilestones.filter(m => !existingSet.has(m));
        if (!newMilestones.length) return [];

        const [player, creatorId] = await Promise.all([
  prisma.user.findUnique({ where: { id: playerId }, select: { name: true, username: true, storeId: true } }),
  getSystemCreatorId(prisma),
]);
        if (!creatorId) {
            console.warn('[bonus-engine] No admin found to create milestone tasks');
            return [];
        }

        const created = [];
        for (const m of newMilestones) {
            // Create pending milestone record
            const bonus = await prisma.depositMilestoneBonus.create({
                data: { playerId, date, milestone: m, bonusAmount: MILESTONE_BONUS },
            });
            created.push(bonus);

            // Auto-create BONUS_FOLLOWUP task for all team members
            const task = await prisma.task.create({
                data: {
                    storeId: player?.storeId || 1,
                    title: `💰 $${m} Daily Milestone — ${player.name} $${m}`,
                    description:
                        `${player.name} (@${player.username}) deposited $${totalToday.toFixed(2)} today (${date}), ` +
                        `hitting the $${m} milestone. Grant the $${MILESTONE_BONUS.toFixed(2)} bonus from the Bonus page.`,
                    taskType: 'BONUS_FOLLOWUP',
                    priority: 'HIGH',
                    status: 'PENDING',
                    createdById: creatorId,
                    assignToAll: true,
                    notes: JSON.stringify({
                        playerId, playerName: player.name, username: player.username,
                        bonusType: 'milestone',
                        milestoneAmount: m,
                        bonusAmount: MILESTONE_BONUS,
                        milestoneId: bonus.id,
                        date,
                    }),
                    checklistItems: [{
                        id: `mile_${bonus.id}`,
                        label: `Grant $${MILESTONE_BONUS} milestone bonus to ${player.name}`,
                        fieldKey: 'grant_bonus',
                        required: true,
                        done: false,
                    }],
                },
            });
            // broadcastFn?.('task_created', task);
            broadcastFn?.('task_created', task, task.storeId);
        }

        console.log(`[bonus-engine] Created ${created.length} milestone record(s) for player ${playerId}`);
        return created;
    } catch (err) {
        console.error('[bonus-engine] checkMilestoneBonuses error:', err.message);
        return [];
    }
}

// ── 3. MATCH BONUS TASK ───────────────────────────────────────────
// Called after every deposit. Creates a BONUS_FOLLOWUP task if no
// match bonus has been granted today for this player.
export async function checkMatchBonusTask(playerId, prisma, broadcastFn, storeId = 1) {
    try {
        const now = new Date();
        const depDay = new Date(now); depDay.setHours(0, 0, 0, 0);
        const depDayEnd = new Date(depDay); depDayEnd.setHours(23, 59, 59, 999);

        // Already got a match bonus today?
        const matchBonusTx = await prisma.transaction.findFirst({
            where: {
                userId: playerId, type: 'BONUS', status: 'COMPLETED',
                description: { contains: 'Match Bonus' },
                createdAt: { gte: depDay, lte: depDayEnd },
            },
        });
        if (matchBonusTx) return; // already granted today

        // Already have an open task for today?
        const recentWindow = new Date(depDay); // start of today
        const existingTask = await prisma.task.findFirst({
            where: {
                taskType: 'BONUS_FOLLOWUP',
                status: { in: ['PENDING', 'IN_PROGRESS'] },
                storeId,
                notes: { contains: `"playerId":${playerId}` },
                createdAt: { gte: recentWindow },
            },
        });
        // Check bonusType specifically
        if (existingTask) {
            try {
                const meta = JSON.parse(existingTask.notes || '{}');
                if (meta.bonusType === 'match') return;
            } catch { return; }
        }

        // Get today's deposit amount for this player
        const { _sum } = await prisma.transaction.aggregate({
            where: {
                userId: playerId, type: 'DEPOSIT', status: 'COMPLETED',
                createdAt: { gte: depDay, lte: depDayEnd },
            },
            _sum: { amount: true },
        });
        const totalToday = parseFloat(_sum.amount || 0);
        if (totalToday <= 0) return;

        const player = await prisma.user.findUnique({
            where: { id: playerId },
            select: { id: true, name: true, username: true, storeId: true },
        });
        if (!player) return;

        const creatorId = await getSystemCreatorId(prisma);
        if (!creatorId) return;

        const eligibleAmount = parseFloat((totalToday * 0.5).toFixed(2));

        const task = await prisma.task.create({
            data: {
                storeId: player.storeId || storeId,
                title: `💰 Match Bonus: ${player.name} (@${player.username})`,
                description: `${player.name} deposited $${totalToday.toFixed(2)} today. No match bonus (50% = $${eligibleAmount}) granted yet.`,
                taskType: 'BONUS_FOLLOWUP',
                priority: 'MEDIUM',
                status: 'PENDING',
                createdById: creatorId,
                assignToAll: true,
                notes: JSON.stringify({
                    playerId: player.id,
                    playerName: player.name,
                    username: player.username,
                    bonusType: 'match',
                    eligibleAmount,
                    details: `Deposited $${totalToday.toFixed(2)} today. Match bonus = $${eligibleAmount}`,
                    generatedAt: now.toISOString(),
                    triggeredBy: 'deposit',
                }),
                checklistItems: [{
                    id: `match_${playerId}_${Date.now()}`,
                    label: 'Grant match bonus for recent deposit',
                    fieldKey: 'granted',
                    required: true,
                    done: false,
                    completedBy: null,
                    completedAt: null,
                }],
            },
        });

        broadcastFn?.('task_created', task, task.storeId);
        console.log(`[bonus-engine] Match bonus task created for ${player.name}`);
    } catch (err) {
        console.error('[bonus-engine] checkMatchBonusTask error:', err.message);
    }
}

// ── 4. REFERRAL BONUS TASK ────────────────────────────────────────
// Called after every deposit where bonusReferral=true was toggled,
// but we also call it generally to catch any missed referral tasks.
export async function checkReferralBonusTask(playerId, prisma, broadcastFn, storeId = 1) {
    try {
        const player = await prisma.user.findUnique({
            where: { id: playerId },
            select: { id: true, name: true, username: true, referredBy: true, storeId: true },
        });
        if (!player?.referredBy) return; // no referrer, skip

        const referrer = await prisma.user.findUnique({
            where: { id: player.referredBy },
            select: { id: true, name: true, username: true },
        });
        if (!referrer) return;

        // Already have an unclaimed referral bonus record?
        const pendingRb = await prisma.referralBonus.findFirst({
            where: { referrerId: player.referredBy, referredId: playerId, referrerClaimed: false },
        });
        if (!pendingRb) return; // no pending referral bonus to notify about

        // Already have an open task for this?
        const existingTask = await prisma.task.findFirst({
            where: {
                taskType: 'BONUS_FOLLOWUP',
                status: { in: ['PENDING', 'IN_PROGRESS'] },
                storeId: player.storeId || storeId,
                notes: { contains: `"referredPlayerId":${playerId}` },
            },
        });
        if (existingTask) {
            try {
                const meta = JSON.parse(existingTask.notes || '{}');
                if (meta.bonusType === 'referral') return;
            } catch { return; }
        }

        const creatorId = await getSystemCreatorId(prisma);
        if (!creatorId) return;

        const now = new Date();
        const task = await prisma.task.create({
            data: {
                storeId: player.storeId || storeId,
                title: `👥 Referral Bonus: ${player.name} (@${player.username})`,
                description: `${player.name} was referred by ${referrer.name} (@${referrer.username}). Grant Referral Bonus to ${referrer.name}.`,
                taskType: 'BONUS_FOLLOWUP',
                priority: 'HIGH',
                status: 'PENDING',
                createdById: creatorId,
                assignToAll: true,
                notes: JSON.stringify({
                    playerId: referrer.id,
                    referredPlayerId: player.id,
                    playerName: referrer.name,
                    username: player.username,
                    bonusType: 'referral',
                    eligibleAmount: parseFloat(pendingRb.bonusAmount),
                    details: `${player.name} was referred by ${referrer.name}. Deposit: $${parseFloat(pendingRb.depositAmount).toFixed(2)}`,
                    generatedAt: now.toISOString(),
                    triggeredBy: 'deposit',
                }),
                checklistItems: [{
                    id: `ref_${playerId}_${Date.now()}`,
                    label: `Grant referral bonus to ${referrer.name}`,
                    fieldKey: 'granted',
                    required: true,
                    done: false,
                    completedBy: null,
                    completedAt: null,
                }],
            },
        });

        broadcastFn?.('task_created', task, task.storeId);
        console.log(`[bonus-engine] Referral bonus task created for ${referrer.name} ← ${player.name}`);
    } catch (err) {
        console.error('[bonus-engine] checkReferralBonusTask error:', err.message);
    }
}

// ── 5. STREAK BONUS TASK ──────────────────────────────────────────
// Called after every deposit. Creates a task if player has a streak
// >= threshold and hasn't received a streak bonus in 7 days.
export async function checkStreakBonusTask(playerId, prisma, broadcastFn, storeId = 1) {
    try {
        const STREAK_THRESHOLD = parseInt(process.env.STREAK_BONUS_THRESHOLD || '7', 10);

        const player = await prisma.user.findUnique({
            where: { id: playerId },
            select: { id: true, name: true, username: true, currentStreak: true, storeId: true },
        });
        if (!player || (player.currentStreak || 0) < STREAK_THRESHOLD) return;

        // Already received a streak bonus in last 7 days?
        const recentStreakBonus = await prisma.transaction.findFirst({
            where: {
                userId: playerId, type: 'BONUS', status: 'COMPLETED',
                description: { contains: 'Streak Bonus' },
                createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            },
        });
        if (recentStreakBonus) return;

        // Already have an open streak task?
        const existingTask = await prisma.task.findFirst({
            where: {
                taskType: 'BONUS_FOLLOWUP',
                status: { in: ['PENDING', 'IN_PROGRESS'] },
                storeId: player.storeId || storeId,
                notes: { contains: `"playerId":${playerId}` },
            },
        });
        if (existingTask) {
            try {
                const meta = JSON.parse(existingTask.notes || '{}');
                if (meta.bonusType === 'streak') return;
            } catch { return; }
        }

        const creatorId = await getSystemCreatorId(prisma);
        if (!creatorId) return;

        const now = new Date();
        const eligibleAmount = parseFloat((player.currentStreak * 0.5).toFixed(2));

        const task = await prisma.task.create({
            data: {
                storeId: player.storeId || storeId,
                title: `🔥 Streak Bonus: ${player.name} (@${player.username})`,
                description: `${player.name} has a ${player.currentStreak}-day streak and hasn't received a streak bonus in 7 days.`,
                taskType: 'BONUS_FOLLOWUP',
                priority: 'HIGH',
                status: 'PENDING',
                createdById: creatorId,
                assignToAll: true,
                notes: JSON.stringify({
                    playerId: player.id,
                    playerName: player.name,
                    username: player.username,
                    bonusType: 'streak',
                    eligibleAmount,
                    details: `${player.currentStreak}-day streak. Eligible for $${eligibleAmount} streak bonus.`,
                    generatedAt: now.toISOString(),
                    triggeredBy: 'deposit',
                }),
                checklistItems: [{
                    id: `streak_${playerId}_${Date.now()}`,
                    label: 'Grant streak bonus',
                    fieldKey: 'granted',
                    required: true,
                    done: false,
                    completedBy: null,
                    completedAt: null,
                }],
            },
        });

        broadcastFn?.('task_created', task, task.storeId);
        console.log(`[bonus-engine] Streak bonus task created for ${player.name} (${player.currentStreak} days)`);
    } catch (err) {
        console.error('[bonus-engine] checkStreakBonusTask error:', err.message);
    }
}

// ── 2. REFERRAL WEEKLY BONUS ──────────────────────────────────────
// Call after a deposit by `referredPlayerId`. Looks up their referrer,
// sums the last 7 days of their deposits, upserts the weekly record,
// and (on first creation this week) creates a task.
export async function checkReferralWeeklyBonus(referredPlayerId, prisma, broadcastFn) {
    try {
        const player = await prisma.user.findUnique({
            where: { id: referredPlayerId },
            select: { id: true, name: true, username: true, referredBy: true },
        });
        if (!player?.referredBy) return null;

        const weekOf = getMondayStr();
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        // Rolling 7-day completed deposits for the referred player
        const { _sum } = await prisma.transaction.aggregate({
            where: {
                userId: referredPlayerId,
                type: 'DEPOSIT',
                status: 'COMPLETED',
                createdAt: { gte: sevenDaysAgo },
            },
            _sum: { amount: true },
        });
        const totalDeposits = parseFloat(_sum.amount || 0);
        const bonusAmount = parseFloat((totalDeposits * REFERRAL_PCT).toFixed(2));
        if (bonusAmount < 0.01) return null;

        // Check existing record for this week
        const whereKey = {
            referrerId_referredId_weekOf: {
                referrerId: player.referredBy,
                referredId: referredPlayerId,
                weekOf,
            },
        };
        const existing = await prisma.referralWeeklyBonus.findUnique({ where: whereKey });
        if (existing?.claimed) return null; // already redeemed this week — don't update

        const isNew = !existing;

        // Upsert: update totalDeposits + bonusAmount on every deposit this week
        const record = await prisma.referralWeeklyBonus.upsert({
            where: whereKey,
            create: {
                referrerId: player.referredBy,
                referredId: referredPlayerId,
                weekOf,
                totalDeposits,
                bonusAmount,
            },
            update: { totalDeposits, bonusAmount },
        });

        // Only create the task on the first deposit of the week
        if (isNew) {
            const [referrer, creatorId] = await Promise.all([
                prisma.user.findUnique({
                    where: { id: player.referredBy },
                    select: { name: true, username: true, storeId: true },
                }),
                getSystemCreatorId(prisma),
            ]);

            if (creatorId && referrer) {
                const task = await prisma.task.create({
                    data: {
                        storeId: referrer?.storeId || 1,
                        title:
                            `🔗 Referral Weekly Bonus — ${referrer.name} can claim 10% of ${player.name}'s deposits`,
                        description:
                            `${player.name} (@${player.username}) deposited $${totalDeposits.toFixed(2)} in the last 7 days. ` +
                            `Their referrer ${referrer.name} (@${referrer.username}) can claim ` +
                            `$${bonusAmount.toFixed(2)} (10%). Week of ${weekOf}.`,
                        taskType: 'BONUS_FOLLOWUP',
                        priority: 'MEDIUM',
                        status: 'PENDING',
                        createdById: creatorId,
                        assignToAll: true,
                        notes: JSON.stringify({
                            playerId: player.referredBy,
                            playerName: referrer.name,
                            username: referrer.username,
                            bonusType: 'referral_weekly',
                            referredPlayerId: referredPlayerId,
                            referredPlayerName: player.name,
                            totalDeposits,
                            bonusAmount,
                            weeklyBonusId: record.id,
                            weekOf,
                        }),
                        checklistItems: [{
                            id: `rwb_${record.id}`,
                            label: `Grant $${bonusAmount.toFixed(2)} referral weekly bonus to ${referrer.name}`,
                            fieldKey: 'grant_bonus',
                            required: true,
                            done: false,
                        }],
                    },
                });
                // broadcastFn?.('task_created', task);
                broadcastFn?.('task_created', task, task.storeId);
            }
        }

        console.log(
            `[bonus-engine] Referral weekly: referrer=${player.referredBy}, ` +
            `referred=${referredPlayerId}, week=${weekOf}, bonus=$${bonusAmount}, new=${isNew}`
        );
        return record;
    } catch (err) {
        console.error('[bonus-engine] checkReferralWeeklyBonus error:', err.message);
        return null;
    }
}
