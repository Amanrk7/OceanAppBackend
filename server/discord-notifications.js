// ═══════════════════════════════════════════════════════════════
// DISCORD NOTIFICATION SYSTEM
// ─ Two dedicated webhooks (shifts + alerts) → separate rate limits
// ─ Per-webhook queues with header-based rate limit handling
// ─ Deduplication within a 30 s window
// ─ Never throws — callers always get a boolean result
// ═══════════════════════════════════════════════════════════════

import axios from 'axios';

// ── Timezone helper ──────────────────────────────────────────────
const TX_TZ = 'America/Chicago';

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

// ═══════════════════════════════════════════════════════════════
// WEBHOOK REGISTRY
//
// Add TWO webhooks to your .env:
//   DISCORD_WEBHOOK_SHIFTS   → #shifts channel  (shift start / end)
//   DISCORD_WEBHOOK_ALERTS   → #alerts channel  (low game stock / low wallet)
//
// If you only set one, both channels fall back to it. That degrades
// back to the old single-bucket behaviour, but at least the code
// won't crash.
// ═══════════════════════════════════════════════════════════════

const WEBHOOK = {
    shifts: process.env.DISCORD_WEBHOOK_SHIFTS
        || 'https://discord.com/api/webhooks/1484794783925927957/iapQKccd8JfBPnkZNejeOQ8PIKEdX82hapFAtR4OQfYoUY8_70PkO2cB6YJgf8bBbvE8',
    alerts: process.env.DISCORD_WEBHOOK_ALERTS
        || 'https://discord.com/api/webhooks/1484795044002140262/GZxSFySond9s7E1iJfm_maxydYWiG1KPTAdXRJB9RX3RufYqzdYmaGv8s2Gxs_D3Dd7m',
};

// ═══════════════════════════════════════════════════════════════
// PER-WEBHOOK QUEUE
// Each webhook gets its own independent queue so they never share
// a rate-limit bucket.
// ═══════════════════════════════════════════════════════════════

const SAFE_GAP_MS = 600;   // 600 ms ≈ 1.7 req/s — well under 5/2 s Discord limit
const MAX_RETRIES = 3;
const DEDUP_MS = 30_000;

// Map<webhookUrl, { queue, running, lastSentAt, recentHashes }>
const webhookState = new Map();

function getState(url) {
    if (!webhookState.has(url)) {
        webhookState.set(url, {
            queue: [],
            running: false,
            lastSentAt: 0,
            recentHashes: new Set(),
        });
    }
    return webhookState.get(url);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function hash(payload) {
    const s = JSON.stringify(payload);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h.toString();
}

async function processQueue(url) {
    const state = getState(url);
    if (state.running) return;
    state.running = true;

    while (state.queue.length > 0) {
        const { payload, resolve, tag } = state.queue.shift();

        // Enforce minimum gap between sends
        const gap = Date.now() - state.lastSentAt;
        if (gap < SAFE_GAP_MS) await sleep(SAFE_GAP_MS - gap);

        let success = false;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const resp = await axios.post(url, payload, {
                    timeout: 8_000,
                    validateStatus: null, // don't throw on 4xx
                });

                if (resp.status === 204 || resp.status === 200) {
                    state.lastSentAt = Date.now();
                    success = true;
                    break;
                }

                // NEW — bails early if token is globally rate-limited
if (resp.status === 429) {
    const retryAfter = resp.data?.retry_after ?? 5;
    const waitMs = Math.ceil(retryAfter * 1000) + 200;
    if (retryAfter > 10 && attempt >= 2) {
        console.error(`❌ Discord: webhook globally rate-limited (${retryAfter}s). Regenerate webhook token.`);
        break;
    }
    console.warn(`⏳ Discord 429 on ${url.slice(-20)} — waiting ${waitMs} ms (attempt ${attempt}/${MAX_RETRIES})`);
    await sleep(waitMs);
    continue;
}

                // Any other error — log and bail
                console.error(`❌ Discord ${resp.status}:`, resp.data?.message ?? resp.statusText);
                break;

            } catch (err) {
                console.error(`❌ Discord network error (attempt ${attempt}):`, err.message);
                if (attempt < MAX_RETRIES) await sleep(2_000 * attempt);
            }
        }

        if (!success) {
            console.error(`❌ Discord: gave up after ${MAX_RETRIES} retries (tag: ${tag})`);
        }
        resolve(success);

        // Always enforce gap before next message
        await sleep(SAFE_GAP_MS);
    }

    state.running = false;
}

/**
 * Enqueue a Discord message on the given webhook channel.
 * @param {'shifts'|'alerts'} channel
 * @param {object}  payload   Discord webhook body
 * @param {string}  [tag]     Dedup key — same tag within 30 s is dropped
 * @returns {Promise<boolean>}
 */
export function discordSend(payload, tag = null, channel = 'shifts') {
    const url = WEBHOOK[channel] || WEBHOOK.shifts;
    if (!url) {
        console.error(`discordSend: no webhook URL configured for channel "${channel}"`);
        return Promise.resolve(false);
    }

    const state = getState(url);
    const dedupKey = tag ?? hash(payload);

    if (state.recentHashes.has(dedupKey)) {
        console.log(`🔇 Discord[${channel}]: duplicate suppressed (${dedupKey})`);
        return Promise.resolve(false);
    }
    state.recentHashes.add(dedupKey);
    setTimeout(() => state.recentHashes.delete(dedupKey), DEDUP_MS);

    return new Promise(resolve => {
        state.queue.push({ payload, resolve, tag: dedupKey });
        processQueue(url);
    });
}

// ═══════════════════════════════════════════════════════════════
// THRESHOLD ALERTS  →  #alerts channel
// ═══════════════════════════════════════════════════════════════

const LOW_THRESHOLD = 500;
const ALERT_COOLDOWN = 60 * 60 * 1_000; // 1 hour per entity

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

            const level = game.pointStock <= 0 ? '🔴 DEFICIT' : '🟡 Low Stock';
            await discordSend({
                embeds: [{
                    title: `⚠️ Game Points ${level}`,
                    color: game.pointStock <= 0 ? 0xdc2626 : 0xf59e0b,
                    fields: [
                        { name: 'Game', value: game.name, inline: true },
                        { name: 'Stock', value: `${parseFloat(game.pointStock).toFixed(0)} pts`, inline: true },
                        { name: 'Threshold', value: `${LOW_THRESHOLD} pts`, inline: true },
                    ],
                    footer: { text: 'Top up soon to avoid service disruption' },
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
                    title: '⚠️ Wallet Balance Low',
                    color: 0xef4444,
                    fields: [
                        { name: 'Wallet', value: wallet.name, inline: true },
                        { name: 'Method', value: wallet.method, inline: true },
                        { name: 'Balance', value: `$${parseFloat(wallet.balance).toFixed(2)}`, inline: true },
                        { name: 'Threshold', value: `$${LOW_THRESHOLD}`, inline: true },
                    ],
                    footer: { text: 'Top up this wallet to continue processing cashouts' },
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
            prisma.wallet.findMany({ where: { balance: { lt: LOW_THRESHOLD } } }),
        ]);

        if (!lowGames.length && !lowWallets.length) {
            console.log('✅ Startup check: all games and wallets are above threshold');
            return;
        }

        if (lowGames.length) {
            const fields = lowGames.slice(0, 25).map(g => ({
                name: g.name,
                value: `${parseFloat(g.pointStock).toFixed(0)} pts`,
                inline: true,
            }));
            if (lowGames.length > 25) fields.push({ name: `+${lowGames.length - 25} more`, value: 'Check dashboard', inline: false });

            await discordSend({
                embeds: [{
                    title: `⚠️ ${lowGames.length} Game(s) Low on Points`,
                    color: 0xf59e0b,
                    fields,
                    footer: { text: `Threshold: ${LOW_THRESHOLD} pts  •  Startup scan` },
                    timestamp: new Date().toISOString(),
                }],
            }, 'startup-games', 'alerts');

            lowGames.forEach(g => {
                alerted.games.add(g.id);
                setTimeout(() => alerted.games.delete(g.id), ALERT_COOLDOWN);
            });
            console.log(`⚠️ Startup: ${lowGames.length} low game(s) queued`);
        }

        if (lowWallets.length) {
            const fields = lowWallets.slice(0, 25).map(w => ({
                name: `${w.method} — ${w.name}`,
                value: `$${parseFloat(w.balance).toFixed(2)}`,
                inline: true,
            }));
            if (lowWallets.length > 25) fields.push({ name: `+${lowWallets.length - 25} more`, value: 'Check dashboard', inline: false });

            await discordSend({
                embeds: [{
                    title: `⚠️ ${lowWallets.length} Wallet(s) Low on Balance`,
                    color: 0xef4444,
                    fields,
                    footer: { text: `Threshold: $${LOW_THRESHOLD}  •  Startup scan` },
                    timestamp: new Date().toISOString(),
                }],
            }, 'startup-wallets', 'alerts');

            lowWallets.forEach(w => {
                alerted.wallets.add(w.id);
                setTimeout(() => alerted.wallets.delete(w.id), ALERT_COOLDOWN);
            });
            console.log(`⚠️ Startup: ${lowWallets.length} low wallet(s) queued`);
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
            prisma.wallet.findMany({ where: { balance: { lt: LOW_THRESHOLD } } }),
        ]);
        for (const g of lowGames) await checkThresholdsAndNotify({ gameId: g.id }, prisma);
        for (const w of lowWallets) await checkThresholdsAndNotify({ walletId: w.id }, prisma);
    } catch (err) {
        console.error('Periodic threshold check failed:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// SHIFT NOTIFICATIONS  →  #shifts channel
// ═══════════════════════════════════════════════════════════════

function now() {
    return new Date().toLocaleString('en-US', {
        timeZone: TX_TZ, month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
    });
}

const ROLE_LABELS = {
    ADMIN: '👑 Admin',
    TEAM1: '🔵 Team 1',
    TEAM2: '🟢 Team 2',
    TEAM3: '🟠 Team 3',
    TEAM4: '🟣 Team 4',
};

function roleLabel(role) { return ROLE_LABELS[role] || role; }

// ── Shift start ──────────────────────────────────────────────────
async function sendShiftStart({ memberName, teamRole, shiftId }) {
    await discordSend({
        embeds: [{
            title: '🌅 Shift Started',
            color: 0x22c55e,
            fields: [
                { name: 'Who', value: memberName || '—', inline: true },
                { name: 'Team', value: roleLabel(teamRole), inline: true },
                { name: 'Time', value: now(), inline: true },
            ],
            footer: { text: `Shift #${shiftId} • OceanBets` },
            timestamp: new Date().toISOString(),
        }],
    }, `shift-start-${shiftId}`, 'shifts');
}

// ── Shift end ────────────────────────────────────────────────────
// Sends a rich detailed embed (equivalent to a shift report).
// Discord embeds support up to 25 fields, which is enough for the
// full breakdown without needing a PDF attachment.
async function sendShiftEnd({ memberName, teamRole, shiftId, duration, stats, startSnapshot, endSnapshot, effortReason, improvements }) {
    const st = stats || {};
    const es = endSnapshot || {};

    // ── Financial summary fields ──────────────────────────────────
    const financialFields = [
        { name: '💰 Deposits', value: `$${(st.totalDeposits ?? 0).toFixed(2)}`, inline: true },
        { name: '💸 Cashouts', value: `$${(st.totalCashouts ?? 0).toFixed(2)}`, inline: true },
        { name: '📈 Net Profit', value: `$${(st.netProfit ?? 0).toFixed(2)}`, inline: true },
    ];

    // ── Activity fields ───────────────────────────────────────────
    const activityFields = [
        { name: '🎮 Transactions', value: String(st.transactionCount ?? 0), inline: true },
        { name: '🎁 Bonuses', value: `${st.bonusesGranted ?? 0} ($${(st.totalBonusAmount ?? 0).toFixed(2)})`, inline: true },
        { name: '👤 Players Added', value: String(st.playersAdded ?? 0), inline: true },
        { name: '✅ Tasks Done', value: String(st.tasksCompleted ?? 0), inline: true },
        { name: '🐛 Issues', value: `${st.issuesCreated ?? 0} created / ${st.issuesResolved ?? 0} resolved`, inline: true },
    ];

    // ── Reconciliation fields (only if snapshot data is present) ──
    const reconFields = [];
    if (es.walletChange != null || es.gameChange != null) {
        reconFields.push(
            { name: '\u200b', value: '**── Reconciliation ──**', inline: false },
            { name: '🏦 Wallet Δ', value: `$${(es.walletChange ?? 0).toFixed(2)}`, inline: true },
            { name: '🎲 Game Δ', value: `${(es.gameChange ?? 0).toFixed(2)} pts`, inline: true },
            { name: '⚖️ Balanced', value: es.isBalanced === true ? '✅ Yes' : es.isBalanced === false ? '❌ No' : '—', inline: true },
        );
        if (es.walletDiscrepancy != null && es.walletDiscrepancy !== 0) {
            reconFields.push({ name: '⚠️ Wallet Discrepancy', value: `$${Math.abs(es.walletDiscrepancy).toFixed(2)}`, inline: true });
        }
        if (es.gameDiscrepancy != null && es.gameDiscrepancy !== 0) {
            reconFields.push({ name: '⚠️ Game Discrepancy', value: `${Math.abs(es.gameDiscrepancy).toFixed(2)} pts`, inline: true });
        }
    }

    // ── Feedback fields ───────────────────────────────────────────
    const feedbackFields = [];
    if (st.effortRating != null) {
        const stars = '⭐'.repeat(Math.min(st.effortRating, 10));
        feedbackFields.push({ name: `⭐ Effort (${st.effortRating}/10)`, value: stars, inline: false });
    }
    if (effortReason) feedbackFields.push({ name: '📝 Effort Notes', value: effortReason.slice(0, 300), inline: false });
    if (improvements) feedbackFields.push({ name: '💡 Improvements', value: improvements.slice(0, 300), inline: false });

    // ── Color by balance status ───────────────────────────────────
    const netProfit = st.netProfit ?? 0;
    const color = netProfit > 0 ? 0x22c55e : netProfit < 0 ? 0xef4444 : 0x64748b;

    await discordSend({
        embeds: [{
            title: '🌙 Shift Ended — Report',
            color,
            fields: [
                { name: '👤 Member', value: memberName || '—', inline: true },
                { name: '🏷️ Team', value: roleLabel(teamRole), inline: true },
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

// ── Task assigned ─────────────────────────────────────────────────
async function sendTaskAssigned({ taskTitle, assigneeName, priority, taskType, dueDate, createdByName }) {
    const due = dueDate
        ? new Date(dueDate).toLocaleDateString('en-US', { timeZone: TX_TZ, month: 'short', day: 'numeric' })
        : 'No due date';
    const color = priority === 'HIGH' ? 0xdc2626 : priority === 'MEDIUM' ? 0xd97706 : 0x64748b;

    await discordSend({
        embeds: [{
            title: '📋 New Task Assigned',
            color,
            fields: [
                { name: 'Task', value: taskTitle, inline: false },
                { name: 'Assigned To', value: assigneeName || 'All Members', inline: true },
                { name: 'Priority', value: priority, inline: true },
                { name: 'Type', value: (taskType || '').replace(/_/g, ' '), inline: true },
                { name: 'Due', value: due, inline: true },
                { name: 'Created By', value: createdByName || '—', inline: true },
            ],
            timestamp: new Date().toISOString(),
        }],
    }, `task-assigned-${taskTitle}-${Date.now()}`, 'shifts');
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC notify() DISPATCHER
// ═══════════════════════════════════════════════════════════════

/**
 * @param {'SHIFT_START'|'SHIFT_END'|'TASK_ASSIGNED'} type
 * @param {object} data
 */
export async function notify(type, data) {
    try {
        if (type === 'SHIFT_START') return await sendShiftStart(data);
        if (type === 'SHIFT_END') return await sendShiftEnd(data);
        if (type === 'TASK_ASSIGNED') return await sendTaskAssigned(data);
        console.warn(`notify(): unknown type "${type}"`);
    } catch (err) {
        console.error(`notify(${type}) error:`, err.message);
    }
}
