// ═══════════════════════════════════════════════════════════════
// DISCORD NOTIFICATION SYSTEM — Bot API (not webhooks)
//
// Why Bot API instead of webhooks?
//   • Webhooks share a global IP-based rate limit on shared hosts
//     (Render, Railway, Fly.io) — other tenants can exhaust it
//   • Bot API rate limits are per-channel (5 msg / 5 s) and are
//     tied to YOUR bot token, not your server's IP
//   • Bots never get "globally rate-limited" from a burst at startup
//
// One-time setup (5 min):
//   1. https://discord.com/developers/applications → New Application
//   2. Bot tab → Add Bot → copy TOKEN → add to .env as DISCORD_BOT_TOKEN
//   3. OAuth2 → URL Generator → scopes: bot → permissions: Send Messages
//   4. Open the generated URL → add bot to your server
//   5. In Discord: enable Developer Mode (User Settings → Advanced)
//   6. Right-click your #shifts channel → Copy Channel ID → DISCORD_CHANNEL_SHIFTS
//   7. Right-click your #alerts channel → Copy Channel ID → DISCORD_CHANNEL_ALERTS
// ═══════════════════════════════════════════════════════════════

import axios from 'axios';

const TX_TZ = 'America/Chicago';

// ── Formatting helpers (exported — used by index.js) ─────────────
export function fmtTXDate(date) {
    if (!date) return '—';
    return new Date(date).toLocaleDateString('en-US', {
        timeZone: TX_TZ, month: 'short', day: 'numeric', year: 'numeric',
    });
}

export function fmtTX(date) {
    if (!date) return '—';
    return new Date(date).toLocaleString('en-US', {
        timeZone: TX_TZ, month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
    });
}

// ── Config (all from .env) ────────────────────────────────────────
const BOT_TOKEN      = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_SHIFTS = process.env.DISCORD_CHANNEL_SHIFTS;   // channel ID string
const CHANNEL_ALERTS = process.env.DISCORD_CHANNEL_ALERTS;   // channel ID string

if (!BOT_TOKEN)      console.warn('⚠️  DISCORD_BOT_TOKEN not set — notifications disabled');
if (!CHANNEL_SHIFTS) console.warn('⚠️  DISCORD_CHANNEL_SHIFTS not set');
if (!CHANNEL_ALERTS) console.warn('⚠️  DISCORD_CHANNEL_ALERTS not set');

// ═══════════════════════════════════════════════════════════════
// PER-CHANNEL QUEUE
// Each channel gets its own FIFO queue → independent rate limits.
// Gap: 1100 ms between sends per channel (well under 5/5 s limit).
// On 429: uses the exact X-RateLimit-Reset-After header value.
// Dedup: identical tag within 30 s is silently dropped.
// Never throws — callers always get a boolean.
// ═══════════════════════════════════════════════════════════════

const SEND_GAP_MS = 1_100;
const MAX_RETRIES = 4;
const DEDUP_MS    = 30_000;

// Map<channelId, { queue[], running, lastSentAt, recentTags }>
const chanState = new Map();

function getChanState(channelId) {
    if (!chanState.has(channelId)) {
        chanState.set(channelId, { queue: [], running: false, lastSentAt: 0, recentTags: new Set() });
    }
    return chanState.get(channelId);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function drainQueue(channelId) {
    const s = getChanState(channelId);
    if (s.running) return;
    s.running = true;

    while (s.queue.length > 0) {
        const { payload, resolve, tag } = s.queue.shift();

        // Enforce per-channel gap
        const gap = Date.now() - s.lastSentAt;
        if (gap < SEND_GAP_MS) await sleep(SEND_GAP_MS - gap);

        let success = false;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const resp = await axios.post(
                    `https://discord.com/api/v10/channels/${channelId}/messages`,
                    payload,
                    {
                        headers: {
                            Authorization: `Bot ${BOT_TOKEN}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: 10_000,
                        validateStatus: null,
                    }
                );

                if (resp.status === 200 || resp.status === 201) {
                    s.lastSentAt = Date.now();
                    success = true;
                    break;
                }

                if (resp.status === 429) {
                    // Use Discord's exact reset header — never guess
                    const resetAfter = parseFloat(
                        resp.headers['x-ratelimit-reset-after'] ??
                        resp.data?.retry_after ??
                        2
                    );
                    const waitMs = Math.ceil(resetAfter * 1000) + 100;
                    console.warn(`⏳ Discord 429 ch:${channelId} — waiting ${waitMs}ms (attempt ${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs);
                    continue;
                }

                // 4xx other than 429 = bad payload, don't retry
                if (resp.status >= 400 && resp.status < 500) {
                    console.error(`❌ Discord ${resp.status} ch:${channelId}:`, resp.data?.message);
                    break;
                }

                // 5xx = Discord outage, wait and retry
                if (resp.status >= 500) {
                    console.warn(`⚠️  Discord ${resp.status} — retrying in ${2 * attempt}s`);
                    await sleep(2_000 * attempt);
                    continue;
                }

            } catch (err) {
                console.error(`❌ Discord network error (attempt ${attempt}):`, err.message);
                if (attempt < MAX_RETRIES) await sleep(2_000 * attempt);
            }
        }

        if (!success) console.error(`❌ Discord: gave up after ${MAX_RETRIES} retries (tag: ${tag})`);
        resolve(success);
        await sleep(SEND_GAP_MS);
    }

    s.running = false;
}

/**
 * Send a Discord message via Bot API.
 * @param {object}  payload    Discord message body (embeds, content, etc.)
 * @param {string}  [tag]      Dedup key — same tag within 30 s is dropped
 * @param {'shifts'|'alerts'} [channel]
 * @returns {Promise<boolean>}
 */
export function discordSend(payload, tag = null, channel = 'shifts') {
    if (!BOT_TOKEN) return Promise.resolve(false);

    const channelId = channel === 'alerts' ? CHANNEL_ALERTS : CHANNEL_SHIFTS;
    if (!channelId) {
        console.error(`discordSend: channel ID not configured for "${channel}"`);
        return Promise.resolve(false);
    }

    const s = getChanState(channelId);
    const dedupKey = tag ?? JSON.stringify(payload).slice(0, 80);

    if (s.recentTags.has(dedupKey)) {
        console.log(`🔇 Discord[${channel}]: duplicate suppressed (${dedupKey})`);
        return Promise.resolve(false);
    }
    s.recentTags.add(dedupKey);
    setTimeout(() => s.recentTags.delete(dedupKey), DEDUP_MS);

    return new Promise(resolve => {
        s.queue.push({ payload, resolve, tag: dedupKey });
        drainQueue(channelId);
    });
}

// ═══════════════════════════════════════════════════════════════
// THRESHOLD ALERTS  →  #alerts channel
// ═══════════════════════════════════════════════════════════════

const LOW_THRESHOLD  = 500;
const ALERT_COOLDOWN = 60 * 60 * 1_000;   // 1 hour per entity

const alerted = { games: new Set(), wallets: new Set() };

export async function checkThresholdsAndNotify({ gameId, walletId } = {}, prisma) {
    const tasks = [];

    if (gameId) tasks.push((async () => {
        try {
            const game = await prisma.game.findUnique({ where: { id: gameId } });
            if (!game || game.pointStock >= LOW_THRESHOLD) return;
            if (alerted.games.has(gameId)) return;

            alerted.games.add(gameId);
            setTimeout(() => alerted.games.delete(gameId), ALERT_COOLDOWN);

            const isDeficit = game.pointStock <= 0;
            await discordSend({
                embeds: [{
                    title: isDeficit ? '🔴 Game Points DEFICIT' : '🟡 Game Points Low',
                    color: isDeficit ? 0xdc2626 : 0xf59e0b,
                    fields: [
                        { name: 'Game',      value: game.name,                                       inline: true },
                        { name: 'Stock',     value: `${parseFloat(game.pointStock).toFixed(0)} pts`, inline: true },
                        { name: 'Threshold', value: `${LOW_THRESHOLD} pts`,                          inline: true },
                    ],
                    footer: { text: 'OceanBets • Top up soon to avoid service disruption' },
                    timestamp: new Date().toISOString(),
                }],
            }, `game-low-${gameId}`, 'alerts');
        } catch (err) { console.error('Game threshold check error:', err.message); }
    })());

    if (walletId) tasks.push((async () => {
        try {
            const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
            if (!wallet || wallet.balance >= LOW_THRESHOLD) return;
            if (alerted.wallets.has(walletId)) return;

            alerted.wallets.add(walletId);
            setTimeout(() => alerted.wallets.delete(walletId), ALERT_COOLDOWN);

            await discordSend({
                embeds: [{
                    title: '🔴 Wallet Balance Low',
                    color: 0xef4444,
                    fields: [
                        { name: 'Wallet',    value: wallet.name,                                   inline: true },
                        { name: 'Method',    value: wallet.method,                                 inline: true },
                        { name: 'Balance',   value: `$${parseFloat(wallet.balance).toFixed(2)}`,   inline: true },
                        { name: 'Threshold', value: `$${LOW_THRESHOLD}`,                           inline: true },
                    ],
                    footer: { text: 'OceanBets • Top up to continue processing cashouts' },
                    timestamp: new Date().toISOString(),
                }],
            }, `wallet-low-${walletId}`, 'alerts');
        } catch (err) { console.error('Wallet threshold check error:', err.message); }
    })());

    await Promise.all(tasks);
}

// ── Startup scan ─────────────────────────────────────────────────
export async function runStartupThresholdCheck(prisma) {
    try {
        const [lowGames, lowWallets] = await Promise.all([
            prisma.game.findMany({ where: { pointStock: { lt: LOW_THRESHOLD } } }),
            prisma.wallet.findMany({ where: { balance:   { lt: LOW_THRESHOLD } } }),
        ]);

        if (!lowGames.length && !lowWallets.length) {
            console.log('✅ Startup check: all games and wallets above threshold');
            return;
        }

        if (lowGames.length) {
            const fields = lowGames.slice(0, 25).map(g => ({
                name: g.name, value: `${parseFloat(g.pointStock).toFixed(0)} pts`, inline: true,
            }));
            if (lowGames.length > 25) fields.push({ name: `+${lowGames.length - 25} more`, value: 'Check dashboard', inline: false });
            await discordSend({
                embeds: [{
                    title: `⚠️ ${lowGames.length} Game(s) Low on Points`,
                    color: 0xf59e0b, fields,
                    footer: { text: `Threshold: ${LOW_THRESHOLD} pts  •  Startup scan` },
                    timestamp: new Date().toISOString(),
                }],
            }, 'startup-games', 'alerts');
            lowGames.forEach(g => {
                alerted.games.add(g.id);
                setTimeout(() => alerted.games.delete(g.id), ALERT_COOLDOWN);
            });
        }

        if (lowWallets.length) {
            const fields = lowWallets.slice(0, 25).map(w => ({
                name: `${w.method} — ${w.name}`, value: `$${parseFloat(w.balance).toFixed(2)}`, inline: true,
            }));
            if (lowWallets.length > 25) fields.push({ name: `+${lowWallets.length - 25} more`, value: 'Check dashboard', inline: false });
            await discordSend({
                embeds: [{
                    title: `⚠️ ${lowWallets.length} Wallet(s) Low on Balance`,
                    color: 0xef4444, fields,
                    footer: { text: `Threshold: $${LOW_THRESHOLD}  •  Startup scan` },
                    timestamp: new Date().toISOString(),
                }],
            }, 'startup-wallets', 'alerts');
            lowWallets.forEach(w => {
                alerted.wallets.add(w.id);
                setTimeout(() => alerted.wallets.delete(w.id), ALERT_COOLDOWN);
            });
        }
    } catch (err) {
        console.error('Startup threshold check failed:', err.message);
    }
}

// ── Periodic scan (every 60 min) ─────────────────────────────────
export async function runPeriodicThresholdCheck(prisma) {
    try {
        const [lowGames, lowWallets] = await Promise.all([
            prisma.game.findMany({ where: { pointStock: { lt: LOW_THRESHOLD } } }),
            prisma.wallet.findMany({ where: { balance:   { lt: LOW_THRESHOLD } } }),
        ]);
        for (const g of lowGames)   await checkThresholdsAndNotify({ gameId: g.id },    prisma);
        for (const w of lowWallets) await checkThresholdsAndNotify({ walletId: w.id }, prisma);
    } catch (err) {
        console.error('Periodic threshold check failed:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// SHIFT + TASK NOTIFICATIONS  →  #shifts channel
// ═══════════════════════════════════════════════════════════════

function nowStr() {
    return new Date().toLocaleString('en-US', {
        timeZone: TX_TZ, month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
    });
}

const ROLE_LABELS = {
    ADMIN: '👑 Admin', TEAM1: '🔵 Team 1', TEAM2: '🟢 Team 2',
    TEAM3: '🟠 Team 3', TEAM4: '🟣 Team 4',
};
const roleLabel = r => ROLE_LABELS[r] || r;

async function sendShiftStart({ memberName, teamRole, shiftId }) {
    await discordSend({
        embeds: [{
            title: '🌅 Shift Started',
            color: 0x22c55e,
            fields: [
                { name: '👤 Who',  value: memberName || '—',   inline: true },
                { name: '🏷️ Team', value: roleLabel(teamRole), inline: true },
                { name: '🕐 Time', value: nowStr(),             inline: true },
            ],
            footer: { text: `Shift #${shiftId} • OceanBets` },
            timestamp: new Date().toISOString(),
        }],
    }, `shift-start-${shiftId}`, 'shifts');
}

async function sendShiftEnd({ memberName, teamRole, shiftId, duration, stats, endSnapshot, effortReason, improvements }) {
    const st = stats || {};
    const es = endSnapshot || {};

    const financialFields = [
        { name: '💰 Deposits',   value: `$${(st.totalDeposits ?? 0).toFixed(2)}`, inline: true },
        { name: '💸 Cashouts',   value: `$${(st.totalCashouts ?? 0).toFixed(2)}`, inline: true },
        { name: '📈 Net Profit', value: `$${(st.netProfit    ?? 0).toFixed(2)}`, inline: true },
    ];

    const activityFields = [
        { name: '🎮 Transactions',  value: String(st.transactionCount ?? 0),  inline: true },
        { name: '🎁 Bonuses',       value: `${st.bonusesGranted ?? 0} ($${(st.totalBonusAmount ?? 0).toFixed(2)})`, inline: true },
        { name: '👤 Players Added', value: String(st.playersAdded ?? 0),       inline: true },
        { name: '✅ Tasks Done',    value: String(st.tasksCompleted ?? 0),     inline: true },
        { name: '🐛 Issues',        value: `${st.issuesCreated ?? 0} created / ${st.issuesResolved ?? 0} resolved`, inline: true },
    ];

    const reconFields = [];
    if (es.walletChange != null || es.gameChange != null) {
        reconFields.push(
            { name: '\u200b', value: '**── Reconciliation ──**', inline: false },
            { name: '🏦 Wallet Δ', value: `$${(es.walletChange ?? 0).toFixed(2)}`,  inline: true },
            { name: '🎲 Game Δ',   value: `${(es.gameChange  ?? 0).toFixed(2)} pts`, inline: true },
            { name: '⚖️ Balanced', value: es.isBalanced === true ? '✅ Yes' : es.isBalanced === false ? '❌ No' : '—', inline: true },
        );
        if (es.walletDiscrepancy) reconFields.push({ name: '⚠️ Wallet Gap', value: `$${Math.abs(es.walletDiscrepancy).toFixed(2)}`, inline: true });
        if (es.gameDiscrepancy)   reconFields.push({ name: '⚠️ Game Gap',   value: `${Math.abs(es.gameDiscrepancy).toFixed(2)} pts`, inline: true });
    }

    const feedbackFields = [];
    if (st.effortRating != null) feedbackFields.push({ name: `⭐ Effort (${st.effortRating}/10)`, value: '⭐'.repeat(Math.min(st.effortRating, 10)), inline: false });
    if (effortReason) feedbackFields.push({ name: '📝 Effort Notes', value: effortReason.slice(0, 300), inline: false });
    if (improvements) feedbackFields.push({ name: '💡 Improvements', value: improvements.slice(0, 300), inline: false });

    const netProfit = st.netProfit ?? 0;
    const color = netProfit > 0 ? 0x22c55e : netProfit < 0 ? 0xef4444 : 0x64748b;

    await discordSend({
        embeds: [{
            title: '🌙 Shift Ended — Report',
            color,
            fields: [
                { name: '👤 Member',   value: memberName || '—',   inline: true },
                { name: '🏷️ Team',     value: roleLabel(teamRole), inline: true },
                { name: '⏱️ Duration', value: duration != null ? `${duration} min` : '—', inline: true },
                { name: '\u200b', value: '**── Financial Summary ──**', inline: false },
                ...financialFields,
                { name: '\u200b', value: '**── Activity ──**', inline: false },
                ...activityFields,
                ...reconFields,
                ...feedbackFields,
            ],
            footer: { text: `Shift #${shiftId} • OceanBets` },
            timestamp: new Date().toISOString(),
        }],
    }, `shift-end-${shiftId}`, 'shifts');
}

async function sendTaskAssigned({ taskTitle, assigneeName, priority, taskType, dueDate, createdByName }) {
    const due   = dueDate
        ? new Date(dueDate).toLocaleDateString('en-US', { timeZone: TX_TZ, month: 'short', day: 'numeric' })
        : 'No due date';
    const color = priority === 'HIGH' ? 0xdc2626 : priority === 'MEDIUM' ? 0xd97706 : 0x64748b;

    await discordSend({
        embeds: [{
            title: '📋 New Task Assigned',
            color,
            fields: [
                { name: 'Task',        value: taskTitle,                           inline: false },
                { name: 'Assigned To', value: assigneeName || 'All Members',       inline: true },
                { name: 'Priority',    value: priority,                            inline: true },
                { name: 'Type',        value: (taskType || '').replace(/_/g, ' '), inline: true },
                { name: 'Due',         value: due,                                 inline: true },
                { name: 'Created By',  value: createdByName || '—',               inline: true },
            ],
            timestamp: new Date().toISOString(),
        }],
    }, `task-${taskTitle}-${Date.now()}`, 'shifts');
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC DISPATCHER
// ═══════════════════════════════════════════════════════════════

export async function notify(type, data) {
    try {
        if (type === 'SHIFT_START')   return await sendShiftStart(data);
        if (type === 'SHIFT_END')     return await sendShiftEnd(data);
        if (type === 'TASK_ASSIGNED') return await sendTaskAssigned(data);
        console.warn(`notify(): unknown type "${type}"`);
    } catch (err) {
        console.error(`notify(${type}) error:`, err.message);
    }
}
