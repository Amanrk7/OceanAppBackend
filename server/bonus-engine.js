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
                    title: `💰 $${m} Daily Milestone — ${player.name} earns $${MILESTONE_BONUS}`,
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
            broadcastFn?.('task_created', task);
        }

        console.log(`[bonus-engine] Created ${created.length} milestone record(s) for player ${playerId}`);
        return created;
    } catch (err) {
        console.error('[bonus-engine] checkMilestoneBonuses error:', err.message);
        return [];
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
                broadcastFn?.('task_created', task);
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
