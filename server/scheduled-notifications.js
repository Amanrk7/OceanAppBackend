// ═══════════════════════════════════════════════════════════════
// SCHEDULED NOTIFICATIONS — Player Status / Tasks / Bonus Alerts
//
// Three independent scheduled checks, each with its own cooldown.
//
// ── Check 1: Player Status (HIGHLY_CRITICAL / INACTIVE) ─────────
//   Runs twice daily (configurable). Generates a PDF attachment
//   and posts it to #alerts with a summary embed.
//
// ── Check 2: Task Deadline Alerts ────────────────────────────────
//   Runs hourly. Fires three classes of alert:
//     • 24h warning  — due within 24 hours
//     • Due today    — due date is today
//     • Overdue      — past due date, still open
//   Each class is deduped per task per day.
//
// ── Check 3: Bonus Eligibility Reminders ─────────────────────────
//   Runs twice daily. Checks three bonus types:
//     • Streak  — currentStreak ≥ STREAK_THRESHOLD, no streak bonus
//                 granted in the last STREAK_COOLDOWN_DAYS days
//     • Referral — new player joined (≤ REFERRAL_WINDOW_DAYS ago)
//                  with a referrer, but no REFERRAL bonus tx on file
//     • Match   — deposit in last MATCH_WINDOW_HOURS hours with no
//                 same-day match bonus tx
//
// ── Install ───────────────────────────────────────────────────────
//   npm install pdfkit form-data
//
// ── Wire up in index.js ────────────────────────────────────────
//   import {
//     schedulePlayerStatusCheck,
//     scheduleTaskDeadlineCheck,
//     scheduleBonusEligibilityCheck,
//   } from './scheduled-notifications.js';
//
//   // Inside app.listen callback:
//   schedulePlayerStatusCheck(prisma);
//   scheduleTaskDeadlineCheck(prisma);
//   scheduleBonusEligibilityCheck(prisma);
// ═══════════════════════════════════════════════════════════════

import PDFDocument from 'pdfkit';
import FormData   from 'form-data';
import axios      from 'axios';
import { fmtTXDate, fmtTX } from './discord-notifications.js';

const TX_TZ = 'America/Chicago';

// ── Config ────────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_SHIFTS = process.env.DISCORD_CHANNEL_SHIFTS;
const CHANNEL_ALERTS = process.env.DISCORD_CHANNEL_ALERTS;
const PROXY_URL      = process.env.DISCORD_PROXY_URL;
const PROXY_SECRET   = process.env.DISCORD_PROXY_SECRET;

// Tunable thresholds
const STREAK_THRESHOLD      = parseInt(process.env.STREAK_BONUS_THRESHOLD      || '7',  10);
const STREAK_COOLDOWN_DAYS  = parseInt(process.env.STREAK_BONUS_COOLDOWN_DAYS  || '7',  10);
const REFERRAL_WINDOW_DAYS  = parseInt(process.env.REFERRAL_WINDOW_DAYS        || '30', 10);
const MATCH_WINDOW_HOURS    = parseInt(process.env.MATCH_WINDOW_HOURS          || '24', 10);

// How often each job fires (ms)
const PLAYER_STATUS_INTERVAL_MS  = 12 * 60 * 60 * 1000;  // every 12 h
const TASK_CHECK_INTERVAL_MS     =  1 * 60 * 60 * 1000;  // every  1 h
const BONUS_CHECK_INTERVAL_MS    = 12 * 60 * 60 * 1000;  // every 12 h

// Cooldown before the same alert fires again (ms)
const PLAYER_STATUS_COOLDOWN_MS = 10 * 60 * 60 * 1000;  // 10 h
const TASK_ALERT_COOLDOWN_MS    = 20 * 60 * 60 * 1000;  // 20 h (per task per type)
const BONUS_ALERT_COOLDOWN_MS   = 22 * 60 * 60 * 1000;  // 22 h (per player per type)

// In-memory dedup stores
const sentPlayerStatusAt  = { lastSentAt: 0 };
const sentTaskAlerts      = new Map(); // key: `${taskId}-${alertType}`
const sentBonusAlerts     = new Map(); // key: `${playerId}-${bonusType}`

// ═══════════════════════════════════════════════════════════════
// LOW-LEVEL: SEND FILE TO DISCORD (direct API, bypasses proxy)
// Used only for PDF attachments — the proxy handles plain JSON.
// ═══════════════════════════════════════════════════════════════

async function discordSendFile({
  channelId,
  fileBuffer,
  filename     = 'report.pdf',
  contentType  = 'application/pdf',
  content      = '',
  embeds       = [],
  maxRetries   = 3,
}) {
  if (!BOT_TOKEN || !channelId) return false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content, embeds }));
      form.append('files[0]', fileBuffer, { filename, contentType });

      const resp = await axios.post(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bot ${BOT_TOKEN}`,
          },
          timeout: 30_000,
          validateStatus: null,
        }
      );

      if (resp.status === 200 || resp.status === 201) return true;

      if (resp.status === 429) {
        const wait = Math.ceil(parseFloat(resp.data?.retry_after ?? 2) * 1000) + 300;
        console.warn(`⏳ Discord file 429 — waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      console.error(`❌ Discord file upload ${resp.status}:`, resp.data?.message);
      break;
    } catch (err) {
      console.error(`❌ Discord file attempt ${attempt}:`, err.message);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return false;
}

// ── discordSend (JSON) via proxy — same as in discord-notifications.js ──
// Duplicated here so scheduled-notifications is self-contained.
async function discordSendJSON(payload, channel = 'alerts') {
  if (!BOT_TOKEN || !PROXY_URL) return false;
  const channelId = channel === 'shifts' ? CHANNEL_SHIFTS : CHANNEL_ALERTS;
  if (!channelId) return false;
  try {
    const resp = await axios.post(
      PROXY_URL,
      { channelId, botToken: BOT_TOKEN, payload },
      {
        headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': PROXY_SECRET },
        timeout: 15_000,
        validateStatus: null,
      }
    );
    return resp.status === 200 || resp.status === 201;
  } catch (err) {
    console.error('discordSendJSON error:', err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// PDF GENERATION
// ═══════════════════════════════════════════════════════════════

/**
 * Build a PDF buffer listing players by attendance category.
 * @param {{ highlyCritical: object[], inactive: object[] }} data
 * @returns {Promise<Buffer>}
 */
function buildPlayerStatusPDF({ highlyCritical, inactive }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc    = new PDFDocument({ margin: 40, size: 'A4' });

    doc.on('data',  c => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', err => reject(err));

    const PAGE_W = doc.page.width - 80; // usable width (margins)
    const now    = new Date().toLocaleString('en-US', {
      timeZone: TX_TZ, dateStyle: 'full', timeStyle: 'short',
    });

    // ── Header ───────────────────────────────────────────────
    doc
      .fillColor('#1e3a5f')
      .fontSize(20)
      .text('OceanBets — Player Attendance Alert', { align: 'center' })
      .moveDown(0.3)
      .fontSize(10)
      .fillColor('#666')
      .text(`Generated: ${now} (CT)`, { align: 'center' })
      .moveDown(0.3)
      .fillColor('#ef4444')
      .fontSize(11)
      .text(
        `⚠️  ${highlyCritical.length} Highly Critical  |  ${inactive.length} Inactive  |  Total: ${highlyCritical.length + inactive.length}`,
        { align: 'center' }
      )
      .moveDown(1);

    // ── Table helper ─────────────────────────────────────────
    const COL = { name: 0, username: 160, tier: 280, lastDeposit: 340, balance: 470 };
    const COL_LABELS = [
      ['Name', COL.name],
      ['Username', COL.username],
      ['Tier', COL.tier],
      ['Last Deposit', COL.lastDeposit],
      ['Balance', COL.balance],
    ];

    function drawTableHeader(y) {
      doc
        .fillColor('#1e3a5f')
        .fontSize(9)
        .font('Helvetica-Bold');
      COL_LABELS.forEach(([label, x]) => doc.text(label, x + 40, y, { width: 120 }));
      doc.moveTo(40, y + 13).lineTo(40 + PAGE_W, y + 13).strokeColor('#ccc').stroke();
      doc.font('Helvetica');
    }

    function drawSection(title, color, players) {
      if (!players.length) return;

      // Section heading
      doc
        .fillColor(color)
        .fontSize(13)
        .font('Helvetica-Bold')
        .text(title, { underline: false })
        .moveDown(0.4);

      const headerY = doc.y;
      drawTableHeader(headerY);
      doc.moveDown(0.5);

      players.forEach((p, idx) => {
        // Prevent overflow — add new page if needed
        if (doc.y > doc.page.height - 80) {
          doc.addPage();
          drawTableHeader(doc.y);
          doc.moveDown(0.5);
        }

        const rowY = doc.y;
        const bg   = idx % 2 === 0 ? '#f9fafb' : '#ffffff';

        // Row background
        doc
          .fillColor(bg)
          .rect(40, rowY - 2, PAGE_W, 16)
          .fill();

        // Row text
        doc
          .fillColor('#111')
          .fontSize(8.5)
          .font('Helvetica')
          .text(truncate(p.name, 22),       40 + COL.name,       rowY, { width: 115 })
          .text(truncate(p.username, 18),   40 + COL.username,   rowY, { width: 95  })
          .text(p.tier || '—',              40 + COL.tier,       rowY, { width: 55  })
          .text(p.lastDepositDate || 'Never', 40 + COL.lastDeposit, rowY, { width: 120 })
          .text(`$${parseFloat(p.balance || 0).toFixed(2)}`, 40 + COL.balance, rowY, { width: 80 });

        doc.moveDown(0.6);
      });

      doc.moveDown(1);
    }

    const truncate = (str, n) => str && str.length > n ? str.slice(0, n) + '…' : (str || '—');

    drawSection('🔴  Highly Critical Players', '#dc2626', highlyCritical);
    drawSection('⚫  Inactive Players',        '#374151', inactive);

    // ── Footer ───────────────────────────────────────────────
    doc
      .moveDown(1)
      .fontSize(8)
      .fillColor('#aaa')
      .text('OceanBets Operations Dashboard', { align: 'center' });

    doc.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// CHECK 1 — PLAYER STATUS (HIGHLY_CRITICAL / INACTIVE)
// ═══════════════════════════════════════════════════════════════

async function runPlayerStatusNotification(prisma) {
  // Global cooldown
  if (Date.now() - sentPlayerStatusAt.lastSentAt < PLAYER_STATUS_COOLDOWN_MS) return;

  try {
    const now          = new Date();
    const todayStart   = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const twoDaysAgo   = new Date(todayStart); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const sevenDaysAgo = new Date(todayStart); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Fetch all players + last deposit
    const allPlayers = await prisma.user.findMany({
      where : { role: 'PLAYER' },
      select: { id: true, name: true, username: true, balance: true, tier: true },
    });

    if (!allPlayers.length) return;

    const lastDeposits = await prisma.transaction.groupBy({
      by   : ['userId'],
      where: { type: 'DEPOSIT', status: 'COMPLETED', userId: { in: allPlayers.map(p => p.id) } },
      _max : { createdAt: true },
    });

    const lastDepMap = {};
    lastDeposits.forEach(r => { lastDepMap[r.userId] = r._max.createdAt; });

    const highlyCritical = [];
    const inactive       = [];

    for (const p of allPlayers) {
      const lastDep = lastDepMap[p.id];
      const row = {
        ...p,
        lastDepositDate: lastDep ? fmtTXDate(lastDep) : 'Never',
      };
      if (!lastDep || lastDep < sevenDaysAgo) {
        inactive.push(row);
      } else if (lastDep < twoDaysAgo) {
        highlyCritical.push(row);
      }
    }

    const total = highlyCritical.length + inactive.length;
    if (total === 0) {
      console.log('✅ Player status check: no highly-critical or inactive players');
      return;
    }

    sentPlayerStatusAt.lastSentAt = Date.now();

    // ── Build summary embed ───────────────────────────────────
    const embed = {
      title      : '📊 Player Attendance Report',
      color      : 0xef4444,
      description: `**${highlyCritical.length}** players are Highly Critical and **${inactive.length}** are Inactive.\nSee attached PDF for the full list.`,
      fields: [
        { name: '🔴 Highly Critical', value: String(highlyCritical.length), inline: true },
        { name: '⚫ Inactive',         value: String(inactive.length),       inline: true },
        { name: '📅 Report Time',      value: fmtTX(now),                    inline: true },
      ],
    };

    // Inline preview: first 6 of each group (to keep embed readable)
    const previewHC = highlyCritical.slice(0, 6).map(p => `• **${p.name}** (@${p.username}) — last: ${p.lastDepositDate}`).join('\n');
    const previewIn = inactive.slice(0, 6).map(p => `• **${p.name}** (@${p.username}) — last: ${p.lastDepositDate}`).join('\n');

    if (previewHC) embed.fields.push({ name: '🔴 Highly Critical (preview)', value: previewHC, inline: false });
    if (previewIn) embed.fields.push({ name: '⚫ Inactive (preview)',         value: previewIn, inline: false });

    embed.footer = { text: `Full list in attached PDF  •  OceanBets` };
    embed.timestamp = now.toISOString();

    // ── Generate PDF ──────────────────────────────────────────
    let pdfSent = false;
    try {
      const pdfBuf  = await buildPlayerStatusPDF({ highlyCritical, inactive });
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      pdfSent = await discordSendFile({
        channelId  : CHANNEL_ALERTS,
        fileBuffer : pdfBuf,
        filename   : `player-status-${dateStr}.pdf`,
        contentType: 'application/pdf',
        content    : '📊 **Player Attendance Report**',
        embeds     : [embed],
      });
    } catch (pdfErr) {
      console.error('PDF generation error:', pdfErr.message);
    }

    // Fallback: send embed-only if file upload failed
    if (!pdfSent) {
      await discordSendJSON({ embeds: [embed] }, 'alerts');
    }

    console.log(`📊 Player status notification sent — HC: ${highlyCritical.length}, Inactive: ${inactive.length}`);
  } catch (err) {
    console.error('runPlayerStatusNotification error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// CHECK 2 — TASK DEADLINE ALERTS
// ═══════════════════════════════════════════════════════════════

async function runTaskDeadlineNotification(prisma) {
  try {
    const now      = new Date();
    const in24h    = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const openTasks = await prisma.task.findMany({
      where  : { status: { in: ['PENDING', 'IN_PROGRESS'] } },
      include: {
        assignedTo: { select: { id: true, name: true, role: true } },
        createdBy : { select: { id: true, name: true } },
        subTasks  : {
          include: { assignedTo: { select: { id: true, name: true } } },
        },
      },
    });

    if (!openTasks.length) return;

    const alerts = { warning24h: [], dueToday: [], overdue: [] };

    for (const task of openTasks) {
      if (!task.dueDate) continue;

      const due    = new Date(task.dueDate);
      const key24h = `${task.id}-24h`;
      const keyOvd = `${task.id}-overdue`;
      const keyDay = `${task.id}-today`;

      if (due < now) {
        // Overdue
        if (!sentTaskAlerts.has(keyOvd) || Date.now() - sentTaskAlerts.get(keyOvd) > TASK_ALERT_COOLDOWN_MS) {
          alerts.overdue.push(task);
          sentTaskAlerts.set(keyOvd, Date.now());
        }
      } else if (due <= in24h) {
        // Within 24h
        const todayMidnight = new Date(now); todayMidnight.setHours(23, 59, 59, 999);
        const isToday       = due <= todayMidnight;

        if (isToday && (!sentTaskAlerts.has(keyDay) || Date.now() - sentTaskAlerts.get(keyDay) > TASK_ALERT_COOLDOWN_MS)) {
          alerts.dueToday.push(task);
          sentTaskAlerts.set(keyDay, Date.now());
        } else if (!isToday && (!sentTaskAlerts.has(key24h) || Date.now() - sentTaskAlerts.get(key24h) > TASK_ALERT_COOLDOWN_MS)) {
          alerts.warning24h.push(task);
          sentTaskAlerts.set(key24h, Date.now());
        }
      }
    }

    const totalAlerts = alerts.warning24h.length + alerts.dueToday.length + alerts.overdue.length;
    if (!totalAlerts) return;

    // ── Build embed ───────────────────────────────────────────
    function taskLines(tasks) {
      return tasks.slice(0, 10).map(t => {
        const due      = t.dueDate ? fmtTX(t.dueDate) : 'No due date';
        const assignee = t.assignedTo?.name || (t.assignToAll ? 'All Members' : '—');
        return `• **${t.title}**\n  Assigned: ${assignee} | Due: ${due} | Priority: ${t.priority}`;
      }).join('\n');
    }

    const fields = [];
    if (alerts.overdue.length)   fields.push({ name: `🔴 Overdue (${alerts.overdue.length})`,        value: taskLines(alerts.overdue),   inline: false });
    if (alerts.dueToday.length)  fields.push({ name: `🟡 Due Today (${alerts.dueToday.length})`,     value: taskLines(alerts.dueToday),  inline: false });
    if (alerts.warning24h.length)fields.push({ name: `🟠 Due in <24h (${alerts.warning24h.length})`, value: taskLines(alerts.warning24h),inline: false });

    // Truncate long field values (Discord 1024 char limit per field)
    fields.forEach(f => { if (f.value.length > 1000) f.value = f.value.slice(0, 997) + '…'; });

    const color = alerts.overdue.length ? 0xdc2626 : alerts.dueToday.length ? 0xf59e0b : 0xf97316;

    await discordSendJSON({
      embeds: [{
        title      : '📋 Task Deadline Alert',
        color,
        description: `**${totalAlerts}** task(s) need attention.`,
        fields,
        footer     : { text: 'OceanBets Task Tracker' },
        timestamp  : now.toISOString(),
      }],
    }, 'shifts');

    console.log(`📋 Task deadline alert sent — overdue: ${alerts.overdue.length}, today: ${alerts.dueToday.length}, 24h: ${alerts.warning24h.length}`);
  } catch (err) {
    console.error('runTaskDeadlineNotification error:', err.message);
  }
}

// ─── Daily "pending tasks" summary (all open tasks, not deadline-specific) ───
async function runDailyTaskSummary(prisma) {
  const key = 'daily-task-summary';
  if (sentTaskAlerts.has(key) && Date.now() - sentTaskAlerts.get(key) < 22 * 60 * 60 * 1000) return;

  try {
    const openTasks = await prisma.task.findMany({
      where  : { status: { in: ['PENDING', 'IN_PROGRESS'] } },
      include: {
        assignedTo: { select: { id: true, name: true, role: true } },
        subTasks  : { include: { assignedTo: { select: { id: true, name: true } } } },
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
    });

    if (!openTasks.length) return;
    sentTaskAlerts.set(key, Date.now());

    // Group by assignee
    const byAssignee = {};
    for (const t of openTasks) {
      const label = t.assignedTo?.name || (t.assignToAll ? 'All Members' : 'Unassigned');
      if (!byAssignee[label]) byAssignee[label] = [];
      byAssignee[label].push(t);
    }

    const fields = Object.entries(byAssignee).slice(0, 10).map(([name, tasks]) => ({
      name,
      value: tasks.slice(0, 5).map(t => {
        const due = t.dueDate ? ` | Due: ${fmtTX(t.dueDate)}` : '';
        return `• ${t.title} [${t.priority}]${due}`;
      }).join('\n').slice(0, 1000) || '—',
      inline: false,
    }));

    await discordSendJSON({
      embeds: [{
        title      : '📋 Daily Task Summary',
        color      : 0x3b82f6,
        description: `**${openTasks.length}** open task(s) across all team members.`,
        fields,
        footer     : { text: 'OceanBets Operations' },
        timestamp  : new Date().toISOString(),
      }],
    }, 'shifts');

    console.log(`📋 Daily task summary sent — ${openTasks.length} open tasks`);
  } catch (err) {
    console.error('runDailyTaskSummary error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// CHECK 3 — BONUS ELIGIBILITY REMINDERS
// ═══════════════════════════════════════════════════════════════

async function runBonusEligibilityNotification(prisma) {
  try {
    const now = new Date();

    // ── 3A: Streak Bonus Eligible ─────────────────────────────
    const streakEligible = await prisma.user.findMany({
      where : {
        role         : 'PLAYER',
        currentStreak: { gte: STREAK_THRESHOLD },
        lastPlayedDate: {
          gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), // active recently
        },
      },
      select: { id: true, name: true, username: true, currentStreak: true, lastPlayedDate: true, balance: true },
    });

    const streakReminders = [];
    for (const p of streakEligible) {
      const cooldownKey = `${p.id}-streak`;
      if (sentBonusAlerts.has(cooldownKey) && Date.now() - sentBonusAlerts.get(cooldownKey) < BONUS_ALERT_COOLDOWN_MS) continue;

      // Check if they received a streak bonus recently (within STREAK_COOLDOWN_DAYS)
      const since = new Date(now.getTime() - STREAK_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
      const recentStreakBonus = await prisma.transaction.findFirst({
        where: {
          userId     : p.id,
          type       : 'BONUS',
          status     : 'COMPLETED',
          description: { contains: 'Streak Bonus' },
          createdAt  : { gte: since },
        },
      });

      if (!recentStreakBonus) {
        streakReminders.push(p);
        sentBonusAlerts.set(cooldownKey, Date.now());
      }
    }

    // ── 3B: Referral Bonus Not Yet Given ──────────────────────
    const cutoff = new Date(now.getTime() - REFERRAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const newReferredPlayers = await prisma.user.findMany({
      where: {
        role     : 'PLAYER',
        referredBy: { not: null },
        createdAt: { gte: cutoff },
      },
      include: {
        referrer: { select: { id: true, name: true, username: true } },
      },
    });

    const referralReminders = [];
    for (const p of newReferredPlayers) {
      const cooldownKey = `${p.id}-referral`;
      if (sentBonusAlerts.has(cooldownKey) && Date.now() - sentBonusAlerts.get(cooldownKey) < BONUS_ALERT_COOLDOWN_MS) continue;

      // Check if a REFERRAL bonus transaction exists for this player
      const referralBonusTx = await prisma.transaction.findFirst({
        where: {
          userId     : p.id,
          type       : 'BONUS',
          status     : 'COMPLETED',
          description: { contains: 'Referral Bonus' },
        },
      });

      if (!referralBonusTx) {
        referralReminders.push(p);
        sentBonusAlerts.set(cooldownKey, Date.now());
      }
    }

    // ── 3C: Match Bonus Not Claimed (recent deposits) ─────────
    const depositWindow = new Date(now.getTime() - MATCH_WINDOW_HOURS * 60 * 60 * 1000);
    const recentDepositors = await prisma.transaction.findMany({
      where  : { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: depositWindow } },
      include: { user: { select: { id: true, name: true, username: true, balance: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // Dedupe by userId (we only want the most recent deposit per player)
    const uniqueDepositors = [];
    const seenIds = new Set();
    for (const tx of recentDepositors) {
      if (!seenIds.has(tx.userId)) {
        seenIds.add(tx.userId);
        uniqueDepositors.push({ player: tx.user, depositAt: tx.createdAt, depositAmt: parseFloat(tx.amount) });
      }
    }

    const matchReminders = [];
    for (const { player, depositAt, depositAmt } of uniqueDepositors) {
      const cooldownKey = `${player.id}-match`;
      if (sentBonusAlerts.has(cooldownKey) && Date.now() - sentBonusAlerts.get(cooldownKey) < BONUS_ALERT_COOLDOWN_MS) continue;

      // Check for a match bonus on the same day as the deposit
      const depDay     = new Date(depositAt); depDay.setHours(0, 0, 0, 0);
      const depDayEnd  = new Date(depDay); depDayEnd.setHours(23, 59, 59, 999);

      const matchBonusTx = await prisma.transaction.findFirst({
        where: {
          userId     : player.id,
          type       : 'BONUS',
          status     : 'COMPLETED',
          description: { contains: 'Match Bonus' },
          createdAt  : { gte: depDay, lte: depDayEnd },
        },
      });

      if (!matchBonusTx) {
        matchReminders.push({ player, depositAt, depositAmt });
        sentBonusAlerts.set(cooldownKey, Date.now());
      }
    }

    const total = streakReminders.length + referralReminders.length + matchReminders.length;
    if (!total) {
      console.log('✅ Bonus eligibility check: no pending bonuses found');
      return;
    }

    // ── Build embed ───────────────────────────────────────────
    const fields = [];

    if (streakReminders.length) {
      fields.push({
        name : `🔥 Streak Bonus Eligible (${streakReminders.length})`,
        value: streakReminders.slice(0, 10)
          .map(p => `• **${p.name}** (@${p.username}) — ${p.currentStreak} day streak`)
          .join('\n').slice(0, 1000),
        inline: false,
      });
    }

    if (referralReminders.length) {
      fields.push({
        name : `👥 Referral Bonus Pending (${referralReminders.length})`,
        value: referralReminders.slice(0, 10)
          .map(p => `• **${p.name}** (@${p.username}) — referred by ${p.referrer?.name || '—'} | Joined: ${fmtTXDate(p.createdAt)}`)
          .join('\n').slice(0, 1000),
        inline: false,
      });
    }

    if (matchReminders.length) {
      fields.push({
        name : `🎁 Match Bonus Not Granted (${matchReminders.length})`,
        value: matchReminders.slice(0, 10)
          .map(({ player, depositAt, depositAmt }) =>
            `• **${player.name}** (@${player.username}) — $${depositAmt.toFixed(2)} deposited ${fmtTX(depositAt)}`
          ).join('\n').slice(0, 1000),
        inline: false,
      });
    }

    await discordSendJSON({
      embeds: [{
        title      : '🎁 Bonus Eligibility Reminder',
        color      : 0xf59e0b,
        description: `**${total}** player(s) may have uncollected bonuses.`,
        fields,
        footer     : { text: 'Go to Dashboard → Bonuses to grant these manually' },
        timestamp  : now.toISOString(),
      }],
    }, 'alerts');

    console.log(`🎁 Bonus eligibility alert sent — streak: ${streakReminders.length}, referral: ${referralReminders.length}, match: ${matchReminders.length}`);
  } catch (err) {
    console.error('runBonusEligibilityNotification error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULERS  (call these from index.js inside app.listen)
// ═══════════════════════════════════════════════════════════════

/**
 * Schedule the player status (highly-critical/inactive) check.
 * Fires once immediately (after 5s warmup), then every 12 hours.
 */
export function schedulePlayerStatusCheck(prisma) {
  console.log('📊 Scheduling player status notifications (every 12h)');
  setTimeout(() => runPlayerStatusNotification(prisma), 5_000);
  setInterval(() => runPlayerStatusNotification(prisma), PLAYER_STATUS_INTERVAL_MS);
}

/**
 * Schedule task deadline and daily summary checks.
 * Deadline check runs every hour.
 * Daily summary runs once per day (fires at first interval check after the
 * daily summary cooldown has expired — effectively once every 22+ hours).
 */
export function scheduleTaskDeadlineCheck(prisma) {
  console.log('📋 Scheduling task deadline notifications (every 1h)');

  const run = () => {
    runTaskDeadlineNotification(prisma);
    runDailyTaskSummary(prisma);
  };

  setTimeout(run, 10_000); // first run 10s after boot
  setInterval(run, TASK_CHECK_INTERVAL_MS);
}

/**
 * Schedule the bonus eligibility reminder.
 * Fires once 30s after boot, then every 12 hours.
 */
export function scheduleBonusEligibilityCheck(prisma) {
  console.log('🎁 Scheduling bonus eligibility notifications (every 12h)');
  setTimeout(() => runBonusEligibilityNotification(prisma), 30_000);
  setInterval(() => runBonusEligibilityNotification(prisma), BONUS_CHECK_INTERVAL_MS);
}
