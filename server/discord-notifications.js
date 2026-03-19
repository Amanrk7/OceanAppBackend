// ═══════════════════════════════════════════════════════════════
// DISCORD NOTIFICATION SYSTEM — Robust, rate-limit-safe
// Drop this in place of your existing Discord section in index.js
// ═══════════════════════════════════════════════════════════════

import axios from 'axios';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ||
    'https://discord.com/api/webhooks/1484117222325620786/pKEWZ7fNYDTPSVuLcj8cC0yRZSIer_M-2d_Ry8vxLHvkEVtkkoKJoCH0X4_8uDJApcVQ';

const TX_TZ = 'America/Chicago';

// ── Formatting helpers ────────────────────────────────────────────
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
// QUEUE-BASED DISCORD SENDER
// - Processes one message at a time (FIFO)
// - Enforces 2.5s minimum gap between sends
// - Exponential backoff on 429s (max 3 retries)
// - Drops duplicates within a 30s window
// ═══════════════════════════════════════════════════════════════

const MIN_SEND_GAP_MS = 2500;   // Discord safe: ~2.5s between webhook calls
const MAX_RETRIES = 3;
const DEDUP_WINDOW_MS = 30_000; // ignore identical payloads within 30s

const queue = [];          // Array<{ payload, resolve, reject }>
let queueRunning = false;
let lastSentAt = 0;
const recentHashes = new Set();   // dedup cache

// Simple hash to deduplicate identical payloads
function hashPayload(payload) {
    const str = JSON.stringify(payload);
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h.toString();
}

async function processQueue() {
    if (queueRunning) return;
    queueRunning = true;

    while (queue.length > 0) {
        const { payload, resolve, reject } = queue.shift();

        // Enforce minimum gap
        const sinceLast = Date.now() - lastSentAt;
        if (sinceLast < MIN_SEND_GAP_MS) {
            await sleep(MIN_SEND_GAP_MS - sinceLast);
        }

        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                await axios.post(DISCORD_WEBHOOK_URL, payload, { timeout: 8000 });
                lastSentAt = Date.now();
                resolve(true);
                lastError = null;
                break;
            } catch (err) {
                lastError = err;
                const status = err.response?.status;
                const retryAfter = err.response?.data?.retry_after;

                if (status === 429) {
                    const waitMs = retryAfter
                        ? Math.ceil(retryAfter) * 1000 + 500
                        : Math.pow(2, attempt) * 2000;   // 4s, 8s, 16s
                    console.warn(`⏳ Discord 429 — waiting ${waitMs}ms (attempt ${attempt}/${MAX_RETRIES})`);
                    await sleep(waitMs);
                } else {
                    // Non-rate-limit error — log and give up immediately
                    const detail = err.response?.data?.message || err.message;
                    console.error(`❌ Discord send failed [${status ?? 'network'}]: ${detail}`);
                    break;
                }
            }
        }

        if (lastError) {
            console.error('❌ Discord: gave up after retries');
            resolve(false);   // resolve (not reject) so callers don't crash
        }

        // Always wait the gap before the next message, even after an error
        await sleep(MIN_SEND_GAP_MS);
    }

    queueRunning = false;
}

/**
 * Primary send function — enqueues payload, deduplicates, never throws.
 * @param {object} payload  Discord webhook body
 * @param {string} [tag]    Optional dedup tag (same tag = same message ignored)
 * @returns {Promise<boolean>}
 */
export function discordSend(payload, tag = null) {
    // Deduplication
    const hash = tag ?? hashPayload(payload);
    if (recentHashes.has(hash)) {
        console.log(`🔇 Discord: duplicate suppressed (tag: ${hash})`);
        return Promise.resolve(false);
    }
    recentHashes.add(hash);
    setTimeout(() => recentHashes.delete(hash), DEDUP_WINDOW_MS);

    return new Promise((resolve, reject) => {
        queue.push({ payload, resolve, reject });
        processQueue();   // idempotent — only starts loop if not running
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════
// THRESHOLD ALERTS
// ═══════════════════════════════════════════════════════════════

const LOW_THRESHOLD = 500;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;  // 1 hour cooldown per entity
const recentlyAlerted = { games: new Set(), wallets: new Set() };

/**
 * Check a single game and/or wallet and send an alert if below threshold.
 * Called after every deposit/cashout/bonus.
 */
export async function checkThresholdsAndNotify({ gameId, walletId } = {}, prisma) {
    const tasks = [];

    if (gameId) {
        tasks.push((async () => {
            try {
                const game = await prisma.game.findUnique({ where: { id: gameId } });
                if (!game) return;
                if (game.pointStock >= LOW_THRESHOLD) return;
                if (recentlyAlerted.games.has(gameId)) return;

                recentlyAlerted.games.add(gameId);
                setTimeout(() => recentlyAlerted.games.delete(gameId), ALERT_COOLDOWN_MS);

                await discordSend({
                    embeds: [{
                        title: '⚠️ Low Game Points Alert',
                        color: 0xf59e0b,
                        fields: [
                            { name: 'Game', value: game.name, inline: true },
                            { name: 'Current Stock', value: `${parseFloat(game.pointStock).toFixed(0)} pts`, inline: true },
                            { name: 'Threshold', value: `${LOW_THRESHOLD} pts`, inline: true },
                        ],
                        footer: { text: 'Reload points soon to avoid service disruption' },
                        timestamp: new Date().toISOString(),
                    }],
                }, `game-low-${gameId}`);
            } catch (err) {
                console.error('Game threshold check error:', err.message);
            }
        })());
    }

    if (walletId) {
        tasks.push((async () => {
            try {
                const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
                if (!wallet) return;
                if (wallet.balance >= LOW_THRESHOLD) return;
                if (recentlyAlerted.wallets.has(walletId)) return;

                recentlyAlerted.wallets.add(walletId);
                setTimeout(() => recentlyAlerted.wallets.delete(walletId), ALERT_COOLDOWN_MS);

                await discordSend({
                    embeds: [{
                        title: '⚠️ Low Wallet Balance Alert',
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
                }, `wallet-low-${walletId}`);
            } catch (err) {
                console.error('Wallet threshold check error:', err.message);
            }
        })());
    }

    await Promise.all(tasks);
}

/**
 * Startup scan — sends ONE batched message for all low games,
 * ONE batched message for all low wallets.
 * Called once, 5s after server boot.
 */
export async function runStartupThresholdCheck(prisma) {
    try {
        const [lowGames, lowWallets] = await Promise.all([
            prisma.game.findMany({ where: { pointStock: { lt: LOW_THRESHOLD } } }),
            prisma.wallet.findMany({ where: { balance: { lt: LOW_THRESHOLD } } }),
        ]);

        if (lowGames.length === 0 && lowWallets.length === 0) {
            console.log('✅ Startup check: all games and wallets above threshold');
            return;
        }

        // ONE message for all low games
        if (lowGames.length > 0) {
            const fields = lowGames.slice(0, 25).map(g => ({
                name: g.name,
                value: `${parseFloat(g.pointStock).toFixed(0)} pts`,
                inline: true,
            }));
            if (lowGames.length > 25) {
                fields.push({ name: `+${lowGames.length - 25} more`, value: 'Check dashboard', inline: false });
            }

            await discordSend({
                embeds: [{
                    title: `⚠️ ${lowGames.length} Game(s) Low on Points`,
                    color: 0xf59e0b,
                    fields,
                    footer: { text: `Threshold: ${LOW_THRESHOLD} pts  •  Server startup check` },
                    timestamp: new Date().toISOString(),
                }],
            }, 'startup-games');

            // Mark as alerted so they don't fire again in the periodic scan immediately after
            lowGames.forEach(g => {
                recentlyAlerted.games.add(g.id);
                setTimeout(() => recentlyAlerted.games.delete(g.id), ALERT_COOLDOWN_MS);
            });
            console.log(`⚠️ Startup: queued batch alert for ${lowGames.length} low game(s)`);
        }

        // ONE message for all low wallets (queued AFTER games — 2.5s gap enforced by queue)
        if (lowWallets.length > 0) {
            const fields = lowWallets.slice(0, 25).map(w => ({
                name: `${w.method} — ${w.name}`,
                value: `$${parseFloat(w.balance).toFixed(2)}`,
                inline: true,
            }));
            if (lowWallets.length > 25) {
                fields.push({ name: `+${lowWallets.length - 25} more`, value: 'Check dashboard', inline: false });
            }

            await discordSend({
                embeds: [{
                    title: `⚠️ ${lowWallets.length} Wallet(s) Low on Balance`,
                    color: 0xef4444,
                    fields,
                    footer: { text: `Threshold: $${LOW_THRESHOLD}  •  Server startup check` },
                    timestamp: new Date().toISOString(),
                }],
            }, 'startup-wallets');

            lowWallets.forEach(w => {
                recentlyAlerted.wallets.add(w.id);
                setTimeout(() => recentlyAlerted.wallets.delete(w.id), ALERT_COOLDOWN_MS);
            });
            console.log(`⚠️ Startup: queued batch alert for ${lowWallets.length} low wallet(s)`);
        }
    } catch (err) {
        console.error('Startup threshold check failed:', err.message);
    }
}

/**
 * Periodic scan — runs every 60 minutes.
 * Scans ALL games + wallets and sends individual alerts for any below threshold.
 * Dedup + cooldown prevents floods.
 */
export async function runPeriodicThresholdCheck(prisma) {
    try {
        const [lowGames, lowWallets] = await Promise.all([
            prisma.game.findMany({ where: { pointStock: { lt: LOW_THRESHOLD } } }),
            prisma.wallet.findMany({ where: { balance: { lt: LOW_THRESHOLD } } }),
        ]);

        // Process sequentially — the queue handles spacing automatically
        for (const game of lowGames) {
            await checkThresholdsAndNotify({ gameId: game.id }, prisma);
        }
        for (const wallet of lowWallets) {
            await checkThresholdsAndNotify({ walletId: wallet.id }, prisma);
        }
    } catch (err) {
        console.error('Periodic threshold check failed:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// SHIFT + TASK NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Send a shift or task notification.
 * @param {'SHIFT_START'|'SHIFT_END'|'TASK_ASSIGNED'} type
 * @param {object} data
 */
export async function notify(type, data) {
    const time = new Date().toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        hour: '2-digit', minute: '2-digit', hour12: true,
        month: 'short', day: 'numeric',
    });

    let payload = null;
    let dedupTag = null;

    if (type === 'SHIFT_START') {
        const { memberName, teamRole, shiftId } = data;
        payload = {
            embeds: [{
                title: '🌅 Shift started',
                color: 0x16a34a,
                fields: [
                    { name: 'Member', value: memberName || teamRole, inline: true },
                    { name: 'Team', value: teamRole, inline: true },
                    { name: 'Time', value: time, inline: true },
                ],
                footer: { text: `Shift #${shiftId}` },
                timestamp: new Date().toISOString(),
            }],
        };
        dedupTag = `shift-start-${shiftId}`;
    }

    else if (type === 'SHIFT_END') {
        const { memberName, teamRole, shiftId, duration, netProfit, isBalanced } = data;
        const balLabel = isBalanced === true ? '✓ Balanced' : isBalanced === false ? '⚠️ Discrepancy' : '—';
        const profitStr = netProfit != null ? `$${Number(netProfit).toFixed(2)}` : '—';
        payload = {
            embeds: [{
                title: '🌙 Shift ended',
                color: 0xdc2626,
                fields: [
                    { name: 'Member', value: memberName || teamRole, inline: true },
                    { name: 'Team', value: teamRole, inline: true },
                    { name: 'Duration', value: duration != null ? `${duration} min` : '—', inline: true },
                    { name: 'Net profit', value: profitStr, inline: true },
                    { name: 'Balanced', value: balLabel, inline: true },
                    { name: 'Time', value: time, inline: true },
                ],
                footer: { text: `Shift #${shiftId}` },
                timestamp: new Date().toISOString(),
            }],
        };
        dedupTag = `shift-end-${shiftId}`;
    }

    else if (type === 'TASK_ASSIGNED') {
        const { taskTitle, assigneeName, priority, taskType, dueDate, createdByName } = data;
        const due = dueDate
            ? new Date(dueDate).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' })
            : 'No due date';
        const color = priority === 'HIGH' ? 0xdc2626 : priority === 'MEDIUM' ? 0xd97706 : 0x64748b;
        payload = {
            embeds: [{
                title: '📋 New task assigned',
                color,
                fields: [
                    { name: 'Task', value: taskTitle, inline: false },
                    { name: 'Assigned to', value: assigneeName || 'All members', inline: true },
                    { name: 'Priority', value: priority, inline: true },
                    { name: 'Type', value: taskType?.replace(/_/g, ' ') || '—', inline: true },
                    { name: 'Due', value: due, inline: true },
                    { name: 'Created by', value: createdByName || '—', inline: true },
                ],
                timestamp: new Date().toISOString(),
            }],
        };
        dedupTag = `task-assigned-${taskTitle}-${Date.now()}`;
    }

    if (!payload) {
        console.warn(`notify(): unknown type "${type}"`);
        return;
    }

    try {
        const sent = await discordSend(payload, dedupTag);
        if (!sent) console.log(`🔇 notify(${type}): suppressed or failed`);
        else console.log(`✅ notify(${type}): queued successfully`);
    } catch (err) {
        // Never crash the caller — shift start/end must succeed even if Discord is down
        console.error(`notify(${type}) error:`, err.message);
    }
}