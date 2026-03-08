/**
 * OceanBets Dashboard Backend Server
 * Complete implementation for frontend dashboard
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';

dotenv.config();

const TX_TZ = 'America/Chicago';

function fmtTXDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', {
    timeZone: TX_TZ, month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtTX(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-US', {
    timeZone: TX_TZ, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const app = express();

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(cors({
  origin: 'https://ocean-app-h1o3.vercel.app',
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ═══════════════════════════════════════════════════════════════
// SERVER TIME
// ═══════════════════════════════════════════════════════════════

app.get('/api/time', (req, res) => {
  res.json({ timestamp: Date.now(), iso: new Date().toISOString(), timezone: 'UTC' });
});

// ═══════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

const authMiddleware = (req, res, next) => {
  try {
    const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized - No token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
};

const adminMiddleware = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true, status: true }
    });
    if (!user || !['ADMIN', 'SUPER_ADMIN'].includes(user.role) || user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Authorization failed' });
  }
};

// ═══════════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.status !== 'ACTIVE') return res.status(403).json({ error: 'Account suspended or banned' });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    res.cookie('token', token, {
      httpOnly: true, secure: true, sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true, token,
      user: { id: user.id, username: user.username, name: user.name, email: user.email, role: user.role, balance: user.balance, tier: user.tier }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out' });
});

// ═══════════════════════════════════════════════════════════════
// USER ENDPOINT
// ═══════════════════════════════════════════════════════════════

app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true, username: true, name: true, email: true, phone: true,
        role: true, status: true, balance: true, tier: true,
        totalWagered: true, totalWon: true, gamesPlayed: true, createdAt: true
      }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PLAYERS ENDPOINTS
// ═══════════════════════════════════════════════════════════════

const TIER_CASHOUT = { BRONZE: 250, SILVER: 500, GOLD: 750 };

const statusToAttendance = (status) => {
  const map = { ACTIVE: 'active', CRITICAL: 'critical', HIGHLY_CRITICAL: 'highly-critical', INACTIVE: 'inactive' };
  return map[status] || 'active';
};

function shapePlayer(user) {
  const tierReqs = { BRONZE: 6000, SILVER: 12000, GOLD: null };
  const nextReq = tierReqs[user.tier];
  const progressPct = nextReq ? Math.min(100, Math.round((user.playTimeMinutes / nextReq) * 100)) : 100;

  const claimed = (user.bonuses || []).filter(b => b.claimed);
  const unclaimed = (user.bonuses || []).filter(b => !b.claimed);
  const totalBonusEarned = claimed.reduce((s, b) => s + parseFloat(b.amount), 0);
  const usedBonus = claimed.reduce((s, b) => s + parseFloat(b.wagerMet || 0), 0);
  const availableBonus = unclaimed.reduce((s, b) => s + parseFloat(b.amount), 0);

  const referralsList = (user.referrals || []).map(r => ({ id: r.id, name: r.name, username: r.username }));
  const friendsList = [...(user.friends || []), ...(user.friendOf || [])].map(f => ({ id: f.id, name: f.name, username: f.username }));

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const transactionHistory = (user.transactions || [])
    .filter(t => new Date(t.createdAt) >= thirtyDaysAgo)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(t => {
      let type = 'other';
      const desc = t.description || '';
      if (t.type === 'DEPOSIT') type = 'deposit';
      else if (t.type === 'WITHDRAWAL') type = 'cashout';
      else if (t.type === 'REFERRAL') type = 'Referral Bonus';
      else if (t.type === 'BONUS') {
        if (desc.includes('Streak Bonus')) type = 'Streak Bonus';
        else if (desc.includes('Referral Bonus')) type = 'Referral Bonus';
        else if (desc.includes('Match Bonus')) type = 'Match Bonus';
        else if (desc.includes('Special Bonus')) type = 'Special Bonus';
        else if (desc.startsWith('Bonus from')) type = 'Bonus';
        else type = 'bonus_credited';
      }

      const walletMatch = desc.match(/via ([^ ]+) - (.+)$/);
      const walletMethod = walletMatch?.[1] || null;
      const walletName = walletMatch?.[2] || null;

      let gameName = null;
      const fromGameDesc = desc.match(/^(?:Streak Bonus|Referral Bonus|Match Bonus|Special Bonus|Bonus) from ([^—\n]+?)(?:\s*—|$)/);
      if (fromGameDesc) gameName = fromGameDesc[1].trim();
      if (!gameName) {
        const noteGameMatch = (t.notes || '').match(/From game: ([^\|]+?)(?:\||$)/);
        if (noteGameMatch) gameName = noteGameMatch[1].trim();
      }

      const weeklyDepositTotal = (user.transactions || [])
        .filter(t => t.type === 'DEPOSIT' && t.status === 'COMPLETED' && new Date(t.createdAt) >= sevenDaysAgo)
        .reduce((sum, t) => sum + parseFloat(t.amount), 0);

      return {
        id: t.id, type, amount: parseFloat(t.amount), status: t.status,
        walletMethod, walletName, gameName,
        weeklyDepositTotal: parseFloat(weeklyDepositTotal.toFixed(2)),
        date: fmtTXDate(t.createdAt),
      };
    });

  const streakBonus = (user.currentStreak || 0) * 0.5;

  return {
    id: user.id, name: user.name, username: user.username, email: user.email,
    phone: user.phone || null, tier: user.tier, status: user.status,
    attendance: statusToAttendance(user.status),
    balance: parseFloat(user.balance), cashoutLimit: parseFloat(user.cashoutLimit),
    source: user.source || '—', createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
    socials: {
      email: user.email, phone: user.phone || null,
      facebook: user.facebook || null, telegram: user.telegram || null,
      instagram: user.instagram || null, x: user.twitterX || null, snapchat: user.snapchat || null,
    },
    referredBy: user.referrer
      ? { id: user.referrer.id, name: user.referrer.name, username: user.referrer.username }
      : null,
    streak: {
      currentStreak: user.currentStreak || 0, streakBonus,
      lastPlayedDate: fmtTXDate(user.lastPlayedDate),
    },
    tierProgress: {
      playTimeMinutes: user.playTimeMinutes || 0,
      progressPercentage: progressPct,
      nextTierRequirement: nextReq,
    },
    bonusTracker: { availableBonus, totalBonusEarned, usedBonus },
    referralsList, friendsList, transactionHistory,
  };
}

// GET /api/players — paginated list
app.get('/api/players', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', status = '' } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const where = { role: 'PLAYER' };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } },
      ];
    }

    const allPlayers = await prisma.user.findMany({
      where,
      select: {
        id: true, username: true, name: true, email: true, phone: true,
        status: true, balance: true, tier: true, tierPoints: true,
        gamesPlayed: true, winStreak: true, currentStreak: true,
        playTimeMinutes: true, lastPlayedDate: true, cashoutLimit: true,
        source: true, facebook: true, telegram: true, instagram: true,
        twitterX: true, snapchat: true, createdAt: true, lastLoginAt: true,
        bonuses: { where: { claimed: false }, select: { amount: true } },
        referrals: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const twoDaysAgo = new Date(todayStart); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const sevenDaysAgo = new Date(todayStart); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const lastDeposits = await prisma.transaction.groupBy({
      by: ['userId'],
      where: { type: 'DEPOSIT', status: 'COMPLETED', userId: { in: allPlayers.map(p => p.id) } },
      _max: { createdAt: true },
    });

    const lastDepositMap = {};
    lastDeposits.forEach(r => { lastDepositMap[r.userId] = r._max.createdAt; });

    const computeStatus = (playerId) => {
      const lastDep = lastDepositMap[playerId];
      if (!lastDep) return 'INACTIVE';
      if (lastDep >= todayStart) return 'ACTIVE';
      if (lastDep >= twoDaysAgo) return 'CRITICAL';
      if (lastDep >= sevenDaysAgo) return 'HIGHLY_CRITICAL';
      return 'INACTIVE';
    };

    const statusFiltered = status ? allPlayers.filter(p => computeStatus(p.id) === status) : allPlayers;
    const total = statusFiltered.length;
    const paginated = statusFiltered.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    const formatted = paginated.map(p => {
      const dynamicStatus = computeStatus(p.id);
      return {
        id: p.id, name: p.name, email: p.email, phone: p.phone,
        status: dynamicStatus, balance: parseFloat(p.balance), tier: p.tier,
        tierPoints: p.tierPoints, cashoutLimit: parseFloat(p.cashoutLimit || 250),
        source: p.source,
        attendance: dynamicStatus === 'ACTIVE' ? 'active' : dynamicStatus === 'CRITICAL' ? 'critical' : dynamicStatus === 'HIGHLY_CRITICAL' ? 'highly-critical' : 'inactive',
        streak: {
          currentStreak: p.currentStreak || 0, lastPlayedDate: p.lastPlayedDate,
          streakBonus: p.currentStreak >= 7 ? 10.00 : p.currentStreak >= 3 ? 5.00 : 0,
        },
        tierProgress: { currentTier: p.tier, playTimeMinutes: p.playTimeMinutes || 0 },
        socials: { email: p.email, phone: p.phone, facebook: p.facebook, telegram: p.telegram, instagram: p.instagram, x: p.twitterX, snapchat: p.snapchat },
        bonusTracker: { availableBonus: p.bonuses.reduce((sum, b) => sum + parseFloat(b.amount), 0) },
        referralsList: p.referrals.map(r => r.id),
        lastLoginAt: fmtTX(p.lastLoginAt), createdAt: fmtTXDate(p.createdAt),
      };
    });

    res.json({ data: formatted, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) || 1 } });
  } catch (err) {
    console.error('Get players error:', err);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// GET /api/players/search — typeahead search (MUST be before /api/players/:id)
app.get('/api/players/search', authMiddleware, async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (q.trim().length < 2) return res.json({ data: [] });

    const players = await prisma.user.findMany({
      where: {
        role: 'PLAYER',
        OR: [
          { name: { contains: q.trim(), mode: 'insensitive' } },
          { username: { contains: q.trim(), mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, username: true, tier: true, status: true, balance: true },
      orderBy: { name: 'asc' },
      take: 10,
    });

    res.json({ data: players });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// ✅ FIX: /api/players/missing-info MUST be before /api/players/:id
// otherwise Express treats "missing-info" as an :id param
app.get('/api/players/missing-info', authMiddleware, async (req, res) => {
  try {
    const players = await prisma.user.findMany({
      where: { role: 'PLAYER' },
      select: {
        id: true, name: true, username: true, email: true, phone: true,
        tier: true, createdAt: true, snapchat: true, instagram: true,
        telegram: true, assignedToId: true,
        assignedTo: { select: { id: true, name: true, role: true } },
      }
    });

    const withMissing = players.map(p => {
      const missing = [];
      if (!p.email) missing.push('email');
      if (!p.phone) missing.push('phone');
      if (!p.snapchat) missing.push('snapchat');
      if (!p.instagram) missing.push('instagram');
      if (!p.telegram) missing.push('telegram');
      if (!p.assignedToId) missing.push('assigned_member');
      return { ...p, missingFields: missing, isCritical: missing.length >= 2 };
    });

    withMissing.sort((a, b) => {
      if (b.isCritical !== a.isCritical) return b.isCritical ? 1 : -1;
      return b.missingFields.length - a.missingFields.length;
    });

    res.json({
      data: withMissing,
      stats: {
        total: withMissing.length,
        critical: withMissing.filter(p => p.isCritical).length,
        missingSnapchat: withMissing.filter(p => p.missingFields.includes('snapchat')).length,
        missingPhone: withMissing.filter(p => p.missingFields.includes('phone')).length,
        missingEmail: withMissing.filter(p => p.missingFields.includes('email')).length,
        unassigned: withMissing.filter(p => p.missingFields.includes('assigned_member')).length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/create-new-player
app.post('/api/create-new-player', authMiddleware, async (req, res) => {
  try {
    const {
      username, password, email, name, phone, tier,
      facebook, telegram, instagram, x, snapchat,
      referrals, friends, sources, initialDeposit, gameId,
    } = req.body;

    const hasSocial = facebook || telegram || instagram || x || snapchat;

if (!username || !name || !hasSocial) {
  return res.status(400).json({ error: 'Name, username, and at least one social handle are required' });
}

    // const existing = await prisma.user.findFirst({ where: { OR: [{ username },  ...(email ? [{ email }] : []),] } });
    const existing = await prisma.user.findFirst({
  where: {
    OR: [
      { username },
      ...(email ? [{ email }] : []),
    ],
  },
});
    if (existing) return res.status(409).json({ error: 'Username or email already exists' });

    // const hashedPassword = await bcrypt.hash(password, 10);
    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
    const resolvedTier = tier || 'BRONZE';

    const toArray = (val) => {
      if (Array.isArray(val)) return val.filter(Boolean);
      if (typeof val === 'string' && val.trim()) return val.split(',').map(s => s.trim()).filter(Boolean);
      return [];
    };

    const referralList = toArray(referrals);
    const friendList = toArray(friends);
    const sourceList = toArray(sources);

    const newPlayer = await prisma.user.create({
      data: {
        username: username.trim(), password: hashedPassword || null, email: email?.trim() || null,
        name: name.trim(), phone: phone?.trim() || null, tier: resolvedTier,
        role: 'PLAYER', status: 'ACTIVE', cashoutLimit: TIER_CASHOUT[resolvedTier] ?? 250,
        facebook: facebook || null, telegram: telegram || null,
        instagram: instagram || null, twitterX: x || null, snapchat: snapchat || null,
        source: sourceList.length ? sourceList.join(', ') : null,
      },
    });

    async function resolveUsers(list) {
      if (!list.length) return [];
      const idNumbers = list.map(v => parseInt(v, 10)).filter(n => !isNaN(n));
      const nameOrUsernames = list.filter(v => isNaN(parseInt(v, 10)));
      return prisma.user.findMany({
        where: {
          OR: [
            ...(idNumbers.length ? [{ id: { in: idNumbers } }] : []),
            ...(nameOrUsernames.length ? [{ username: { in: nameOrUsernames } }] : []),
            ...(nameOrUsernames.length ? [{ name: { in: nameOrUsernames } }] : []),
          ],
        },
        select: { id: true, name: true, username: true },
      });
    }

    let linkedReferrer = null;
    if (referralList.length) {
      const refUsers = await resolveUsers(referralList);
      if (refUsers.length) {
        linkedReferrer = refUsers[0];
        await prisma.user.update({ where: { id: newPlayer.id }, data: { referredBy: linkedReferrer.id } });
      }
    }

    if (friendList.length) {
      const friendUsers = await resolveUsers(friendList);
      if (friendUsers.length) {
        const friendIds = friendUsers.map(f => ({ id: f.id }));
        await prisma.user.update({ where: { id: newPlayer.id }, data: { friends: { connect: friendIds } } });
        await Promise.all(friendIds.map(fid =>
          prisma.user.update({ where: { id: fid.id }, data: { friends: { connect: [{ id: newPlayer.id }] } } })
        ));
      }
    }

    let bonusInfo = null;
    if (linkedReferrer && initialDeposit && parseFloat(initialDeposit) > 0) {
      const depositAmt = parseFloat(initialDeposit);
      const bonusAmt = parseFloat((depositAmt / 2).toFixed(2));
      const now = new Date();

      let game = null;
      if (gameId) {
        game = await prisma.game.findUnique({ where: { id: gameId } });
        if (game && game.pointStock < bonusAmt) game = null;
      }

      const bonusOps = [
        prisma.user.update({ where: { id: linkedReferrer.id }, data: { balance: { increment: bonusAmt } } }),
        prisma.bonus.create({
          data: {
            userId: linkedReferrer.id, type: 'REFERRAL', amount: bonusAmt,
            description: `Referral Match Bonus — ${newPlayer.name} joined with $${depositAmt.toFixed(2)} initial deposit`,
            claimed: true, claimedAt: now,
          },
        }),
        prisma.transaction.create({
          data: {
            userId: linkedReferrer.id, type: 'REFERRAL', amount: bonusAmt, status: 'COMPLETED',
            description: `Referral Match Bonus — ${newPlayer.name} initial deposit $${depositAmt.toFixed(2)}`,
            notes: `New player: ${newPlayer.name} (ID: ${newPlayer.id})`,
          },
        }),
      ];

      if (game) {
        const newStock = game.pointStock - bonusAmt;
        bonusOps.push(prisma.game.update({
          where: { id: game.id },
          data: { pointStock: newStock, status: newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY' },
        }));
      }

      await prisma.$transaction(bonusOps);
      bonusInfo = { referrerId: linkedReferrer.id, referrerName: linkedReferrer.name, bonusAmount: bonusAmt, gameUsed: game?.name || null };
    }

    const fullPlayer = await prisma.user.findUnique({
      where: { id: newPlayer.id },
      include: {
        referrer: { select: { id: true, name: true, username: true } },
        referrals: { select: { id: true, name: true, username: true } },
        friends: { select: { id: true, name: true, username: true } },
        friendOf: { select: { id: true, name: true, username: true } },
      },
    });

    // Auto-log progress on active PLAYER_ADDITION tasks
    const activeTask = await prisma.task.findFirst({
      where: {
        taskType: 'PLAYER_ADDITION',
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        OR: [{ assignedToId: req.userId }, { assignToAll: true }]
      },
      include: { subTasks: true }
    });
    if (activeTask) {
      await incrementTaskProgress(activeTask.id, req.userId, 1, 'PLAYER_ADDED', { playerId: newPlayer.id, playerName: newPlayer.name });
    }

    res.status(201).json({
      data: { ...fullPlayer, password: undefined },
      message: 'Player created successfully',
      referrerBonus: bonusInfo,
    });
  } catch (err) {
    console.error('Create player error:', err);
    res.status(500).json({ error: 'Failed to create player' });
  }
});

// GET /api/players/:id — single player (MUST be after all /players/xxx static routes)
app.get('/api/players/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid player ID' });

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        transactions: { orderBy: { createdAt: 'desc' }, take: 200 },
        bonuses: true,
        referrals: { select: { id: true, name: true, username: true } },
        referrer: { select: { id: true, name: true, username: true } },
        friends: { select: { id: true, name: true, username: true } },
        friendOf: { select: { id: true, name: true, username: true } },
      },
    });

    if (!user) return res.status(404).json({ error: 'Player not found' });
    res.json({ data: shapePlayer(user) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});

// PATCH /api/players/:id
app.patch('/api/players/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid player ID' });

    const {
      name, email, phone, tier, status, balance, cashoutLimit,
      facebook, telegram, instagram, x, snapchat, source,
      currentStreak, lastPlayedDate,
    } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (email !== undefined) updateData.email = email.trim();
    if (phone !== undefined) updateData.phone = phone?.trim() || null;
    if (tier !== undefined) {
      updateData.tier = tier;
      if (cashoutLimit === undefined) updateData.cashoutLimit = TIER_CASHOUT[tier] ?? 250;
    }
    if (cashoutLimit !== undefined) updateData.cashoutLimit = parseFloat(cashoutLimit);
    if (status !== undefined) updateData.status = status;
    if (balance !== undefined) updateData.balance = parseFloat(balance);
    if (facebook !== undefined) updateData.facebook = facebook || null;
    if (telegram !== undefined) updateData.telegram = telegram || null;
    if (instagram !== undefined) updateData.instagram = instagram || null;
    if (x !== undefined) updateData.twitterX = x || null;
    if (snapchat !== undefined) updateData.snapchat = snapchat || null;
    if (source !== undefined) updateData.source = source || null;
    if (currentStreak !== undefined) updateData.currentStreak = parseInt(currentStreak, 10);
    if (lastPlayedDate !== undefined) updateData.lastPlayedDate = lastPlayedDate ? new Date(lastPlayedDate) : null;

    const updated = await prisma.user.update({ where: { id }, data: updateData });
    res.json({ data: { ...updated, password: undefined }, message: 'Player updated successfully' });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Email already in use by another player' });
    res.status(500).json({ error: 'Failed to update player' });
  }
});

// DELETE /api/players/:id
app.delete('/api/players/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid player ID' });

    const { adminPassword } = req.body;
    if (!adminPassword) return res.status(400).json({ error: 'Admin password is required to delete a player' });

    const actingAdmin = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!actingAdmin) return res.status(403).json({ error: 'Admin not found' });

    const passwordMatch = await bcrypt.compare(adminPassword, actingAdmin.password);
    if (!passwordMatch) return res.status(403).json({ error: 'Incorrect admin password' });
    if (id === req.userId) return res.status(400).json({ error: 'You cannot delete your own account' });

    await prisma.user.delete({ where: { id } });
    res.json({ message: 'Player deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete player' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/dashboard/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [
      totalUsers, activeUsers, totalTransactions, pendingTransactions,
      totalDeposits, totalWithdrawals, totalPlayers, newPlayersWeek,
      unresolvedIssues, resolvedIssues, highPriorityIssues,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'PLAYER' } }),
      prisma.user.count({ where: { role: 'PLAYER', status: 'ACTIVE' } }),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: 'PENDING' } }),
      prisma.transaction.aggregate({ where: { type: 'DEPOSIT', status: 'COMPLETED' }, _sum: { amount: true } }),
      prisma.transaction.aggregate({ where: { type: 'WITHDRAWAL', status: 'COMPLETED' }, _sum: { amount: true } }),
      prisma.user.count({ where: { role: 'PLAYER' } }),
      prisma.user.count({ where: { role: 'PLAYER', createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
      prisma.issue.count({ where: { status: 'UNRESOLVED' } }),
      prisma.issue.count({ where: { status: 'RESOLVED' } }),
      prisma.issue.count({ where: { status: 'UNRESOLVED', priority: 'HIGH' } }),
    ]);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

    const [todayDeposits, todayCashouts] = await Promise.all([
      prisma.transaction.aggregate({ where: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: today, lt: tomorrow } }, _sum: { amount: true } }),
      prisma.transaction.aggregate({ where: { type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: today, lt: tomorrow } }, _sum: { amount: true } }),
    ]);

    const deposits = parseFloat(totalDeposits._sum.amount || 0);
    const withdrawals = parseFloat(totalWithdrawals._sum.amount || 0);
    const todayDeposit = parseFloat(todayDeposits._sum.amount || 0);
    const todayCashout = parseFloat(todayCashouts._sum.amount || 0);

    res.json({
      users: { total: totalUsers, active: activeUsers, suspended: totalUsers - activeUsers },
      transactions: { total: totalTransactions, pending: pendingTransactions },
      revenue: { deposits, withdrawals, profit: deposits - withdrawals },
      daily: { deposits: todayDeposit, cashouts: todayCashout, profit: todayDeposit - todayCashout },
      players: { total: totalPlayers, newThisWeek: newPlayersWeek },
      issues: { unresolved: unresolvedIssues, resolved: resolvedIssues, total: unresolvedIssues + resolvedIssues, highPriority: highPriorityIssues },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

app.get('/api/analytics/top-depositors', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const getTop = async (days) => {
      const sinceDate = new Date(); sinceDate.setDate(sinceDate.getDate() - days);
      const top = await prisma.transaction.groupBy({
        by: ['userId'],
        where: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: sinceDate } },
        _sum: { amount: true }, orderBy: { _sum: { amount: 'desc' } }, take: 10,
      });
      return Promise.all(top.map(async (d) => {
        const user = await prisma.user.findUnique({ where: { id: d.userId }, select: { id: true, username: true, name: true } });
        return { ...user, totalDeposited: parseFloat(d._sum.amount) };
      }));
    };
    const [period_1day, period_7days, period_30days] = await Promise.all([getTop(1), getTop(7), getTop(30)]);
    res.json({ period_1day, period_7days, period_30days });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch top depositors' });
  }
});

app.get('/api/analytics/top-cashouts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const getTopCashouts = async (days) => {
      const sinceDate = new Date(); sinceDate.setDate(sinceDate.getDate() - days);
      const top = await prisma.transaction.groupBy({
        by: ['userId'],
        where: { type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: sinceDate } },
        _sum: { amount: true }, orderBy: { _sum: { amount: 'desc' } }, take: 10,
      });
      return Promise.all(top.map(async (d) => {
        const user = await prisma.user.findUnique({ where: { id: d.userId }, select: { id: true, username: true, name: true } });
        return { ...user, totalCashouts: parseFloat(d._sum.amount) };
      }));
    };
    const [period_1day, period_7days, period_30days] = await Promise.all([getTopCashouts(1), getTopCashouts(7), getTopCashouts(30)]);
    res.json({ period_1day, period_7days, period_30days });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch top cashouts' });
  }
});

app.get('/api/profit/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date(today); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const profitData = await prisma.profitStat.findMany({ where: { date: { gte: thirtyDaysAgo, lte: today } }, orderBy: { date: 'asc' } });
    const totalProfit = profitData.reduce((sum, p) => sum + parseFloat(p.profit.toString()), 0);
    const avgProfit = profitData.length > 0 ? totalProfit / profitData.length : 0;
    const maxProfit = profitData.length > 0 ? Math.max(...profitData.map(p => parseFloat(p.profit.toString()))) : 0;
    const minProfit = profitData.length > 0 ? Math.min(...profitData.map(p => parseFloat(p.profit.toString()))) : 0;

    res.json({
      data: profitData.map(p => ({ date: p.date.toISOString().split('T')[0], profit: parseFloat(p.profit.toString()) })),
      summary: { total: parseFloat(totalProfit.toFixed(2)), average: parseFloat(avgProfit.toFixed(2)), max: parseFloat(maxProfit.toFixed(2)), min: parseFloat(minProfit.toFixed(2)), daysCount: profitData.length },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profit stats' });
  }
});

// ═══════════════════════════════════════════════════════════════
// BONUSES ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/bonuses', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const bonusTxns = await prisma.transaction.findMany({
      where: { type: 'BONUS' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { id: true, name: true } } },
    });

    const ledger = bonusTxns.map(t => {
      const desc = t.description || '';
      const notes = t.notes || '';
      let bonusType = 'bonus';
      if (desc.startsWith('Streak Bonus')) bonusType = 'streak';
      else if (desc.startsWith('Referral Bonus')) bonusType = 'referral';
      else if (desc.startsWith('Match Bonus')) bonusType = 'match';
      else if (desc.startsWith('Special Bonus')) bonusType = 'special';

      const gameMatch = desc.match(/^.+? from ([^—\n]+?)(?:\s*—|$)/);
      const gameName = gameMatch ? gameMatch[1].trim() : '—';
      const balBeforeMatch = notes.match(/balanceBefore:([\d.]+)/);
      const balAfterMatch = notes.match(/balanceAfter:([\d.]+)/);

      return {
        id: t.id, playerId: t.userId, playerName: t.user?.name || '—', bonusType,
        description: desc, gameName, walletMethod: null,
        amount: parseFloat(t.amount),
        balanceBefore: balBeforeMatch ? parseFloat(balBeforeMatch[1]) : null,
        balanceAfter: balAfterMatch ? parseFloat(balAfterMatch[1]) : null,
        createdAt: t.createdAt,
      };
    });

    res.json({ data: ledger });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bonus ledger' });
  }
});

app.post('/api/bonuses', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { playerId, amount, gameId, notes, bonusType } = req.body;
    if (!playerId || !amount || !gameId) return res.status(400).json({ error: 'playerId, amount, and gameId are required' });

    const bonusAmount = parseFloat(amount);
    if (isNaN(bonusAmount) || bonusAmount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

    const player = await prisma.user.findUnique({ where: { id: parseInt(playerId) }, select: { id: true, name: true, balance: true, status: true, currentStreak: true, referredBy: true } });
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const game = await prisma.game.findUnique({ where: { id: gameId } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const isStreak = bonusType === 'streak';
    const isReferral = bonusType === 'referral';
    const bonusLabel = isStreak ? 'Streak Bonus' : isReferral ? 'Referral Bonus' : (bonusType || 'Bonus');

    let referrer = null;
    if (isReferral && player.referredBy) {
      referrer = await prisma.user.findUnique({ where: { id: player.referredBy }, select: { id: true, name: true, balance: true } });
    }

    const totalGameDeduction = (referrer ? 2 : 1) * bonusAmount;
    if (game.pointStock < totalGameDeduction) {
      return res.status(400).json({ error: `Insufficient game stock. ${game.name} has ${game.pointStock.toFixed(2)} pts, need ${totalGameDeduction.toFixed(2)} pts` });
    }

    const playerDesc = notes?.trim() ? `${bonusLabel} from ${game.name} — ${notes.trim()}` : `${bonusLabel} from ${game.name}`;
    const referrerDesc = `Referral Bonus from ${game.name} — ${player.name}'s deposit`;
    const newStock = game.pointStock - totalGameDeduction;
    const newGameStatus = newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY';
    const playerBalanceBefore = parseFloat(player.balance);
    const playerBalanceAfter = playerBalanceBefore + bonusAmount;

    const ops = [
      prisma.game.update({ where: { id: gameId }, data: { pointStock: newStock, status: newGameStatus } }),
      prisma.user.update({ where: { id: parseInt(playerId) }, data: { balance: { increment: bonusAmount } } }),
      prisma.bonus.create({ data: { userId: parseInt(playerId), type: isReferral ? 'REFERRAL' : 'CUSTOM', amount: bonusAmount, description: playerDesc, claimed: false } }),
      prisma.transaction.create({ data: { userId: parseInt(playerId), type: 'BONUS', amount: bonusAmount, status: 'COMPLETED', description: playerDesc, paymentMethod: null, notes: `balanceBefore:${playerBalanceBefore}|balanceAfter:${playerBalanceAfter}|${notes?.trim() || ''}` } }),
    ];

    if (isStreak) ops.push(prisma.user.update({ where: { id: parseInt(playerId) }, data: { currentStreak: 0, lastPlayedDate: null } }));

    if (referrer) {
      const referrerBalanceBefore = parseFloat(referrer.balance);
      const referrerBalanceAfter = referrerBalanceBefore + bonusAmount;
      ops.push(prisma.user.update({ where: { id: referrer.id }, data: { balance: { increment: bonusAmount } } }));
      ops.push(prisma.bonus.create({ data: { userId: referrer.id, type: 'REFERRAL', amount: bonusAmount, description: referrerDesc, claimed: false } }));
      ops.push(prisma.transaction.create({ data: { userId: referrer.id, type: 'BONUS', amount: bonusAmount, status: 'COMPLETED', description: referrerDesc, paymentMethod: null, notes: `balanceBefore:${referrerBalanceBefore}|balanceAfter:${referrerBalanceAfter}` } }));
    }

    const results = await prisma.$transaction(ops);
    const updatedGame = results[0];
    const updatedPlayer = results[1];

    res.status(201).json({
      success: true,
      message: [
        `$${bonusAmount.toFixed(2)} ${bonusLabel} granted to ${player.name}.`,
        isStreak ? 'Streak reset to 0.' : '',
        referrer ? `Referrer ${referrer.name} also received $${bonusAmount.toFixed(2)}.` : '',
        `${totalGameDeduction.toFixed(0)} pts deducted from ${game.name}.`,
      ].filter(Boolean).join(' '),
      data: {
        player: { id: updatedPlayer.id, name: updatedPlayer.name, newBalance: parseFloat(updatedPlayer.balance) },
        referrer: referrer ? { id: referrer.id, name: referrer.name, bonusAmount } : null,
        game: { id: updatedGame.id, name: updatedGame.name, newStock: updatedGame.pointStock, status: updatedGame.status },
        streakReset: isStreak,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to grant bonus: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// TRANSACTIONS ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.post('/api/payments', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { amount, walletId, category, date, notes } = req.body;
    if (!amount || !walletId) return res.status(400).json({ error: 'Amount and walletId are required' });

    const wallet = await prisma.wallet.findUnique({ where: { id: parseInt(walletId) } });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    if (wallet.balance < parseFloat(amount)) return res.status(400).json({ error: 'Insufficient wallet balance' });

    const [updatedWallet, payment] = await prisma.$transaction([
      prisma.wallet.update({ where: { id: parseInt(walletId) }, data: { balance: wallet.balance - parseFloat(amount) } }),
      prisma.expense.create({
        data: {
          details: `Payment (${wallet.method} - ${wallet.name})`,
          category: category?.toUpperCase().replace(' ', '_') || 'POINT_RELOAD',
          amount: 0, paymentMade: parseFloat(amount), notes: notes || null, gameId: null,
        }
      })
    ]);

    res.status(201).json({ data: { wallet: updatedWallet, payment }, message: 'Payment recorded and wallet updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

const sameDay = (a, b) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
const isYesterday = (a, b) => { const prev = new Date(b); prev.setUTCDate(prev.getUTCDate() - 1); return sameDay(a, prev); };

app.post('/api/transactions/deposit', authMiddleware, async (req, res) => {
  try {
    const {
      playerId, amount, fee = 0, walletId, walletMethod, walletName, gameId, notes,
      bonusMatch = false, bonusSpecial = false, bonusReferral = false,
    } = req.body;

    if (!playerId || !amount || !walletId) return res.status(400).json({ error: 'playerId, amount and walletId are required' });
    if (!gameId) return res.status(400).json({ error: 'gameId is required for all deposits' });

    const depositAmt = parseFloat(amount);
    const feeAmt = parseFloat(fee) || 0;
    if (isNaN(depositAmt) || depositAmt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (feeAmt < 0 || feeAmt > depositAmt) return res.status(400).json({ error: 'fee must be 0 or more and cannot exceed the deposit amount' });

    const player = await prisma.user.findUnique({ where: { id: parseInt(playerId) }, select: { id: true, name: true, balance: true, tier: true, currentStreak: true, lastPlayedDate: true, referredBy: true } });
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const balanceBefore = parseFloat(player.balance);

    if (bonusMatch) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
      const existingMatchBonus = await prisma.transaction.findFirst({ where: { userId: parseInt(playerId), type: 'BONUS', status: 'COMPLETED', description: { contains: 'Match Bonus' }, createdAt: { gte: todayStart, lte: todayEnd } } });
      if (existingMatchBonus) return res.status(400).json({ error: 'Match bonus already used today for this player.' });
    }

    if (bonusReferral) {
      const existingReferral = await prisma.transaction.findFirst({ where: { userId: parseInt(playerId), type: 'BONUS', status: 'COMPLETED', description: { contains: 'Referral Bonus' } } });
      if (existingReferral) return res.status(400).json({ error: 'Referral bonus has already been used for this player.' });
    }

    let referrer = null;
    if (bonusReferral && player.referredBy) {
      referrer = await prisma.user.findUnique({ where: { id: player.referredBy }, select: { id: true, name: true, balance: true } });
    }

    const wallet = await prisma.wallet.findUnique({ where: { id: parseInt(walletId) }, select: { id: true, name: true, method: true, balance: true } });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const walletBalanceBefore = parseFloat(wallet.balance);

    const game = await prisma.game.findUnique({ where: { id: gameId }, select: { id: true, name: true, pointStock: true } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const matchAmt = bonusMatch ? depositAmt * 0.5 : 0;
    const specialAmt = bonusSpecial ? depositAmt * 0.2 : 0;
    const referralAmt = bonusReferral && referrer ? depositAmt * 0.5 : 0;
    const totalGameDeduction = depositAmt + matchAmt + specialAmt + (referralAmt * (referrer ? 2 : 1));

    if (totalGameDeduction > game.pointStock) {
      return res.status(400).json({ error: `Insufficient game stock. ${game.name} has ${game.pointStock.toFixed(2)} pts, need ${totalGameDeduction.toFixed(2)} pts` });
    }

    const now = new Date();
    const lastPlayed = player.lastPlayedDate ? new Date(player.lastPlayedDate) : null;
    let newStreak = player.currentStreak || 0;
    if (!lastPlayed) newStreak = 1;
    else if (!sameDay(lastPlayed, now)) newStreak = isYesterday(lastPlayed, now) ? newStreak + 1 : 1;

    const ops = [];
    const totalPlayerCredit = depositAmt + matchAmt + specialAmt + referralAmt;
    const balanceAfter = balanceBefore + totalPlayerCredit;
    const walletCredit = depositAmt - feeAmt;

    ops.push(prisma.user.update({ where: { id: parseInt(playerId) }, data: { balance: balanceAfter, currentStreak: newStreak, lastPlayedDate: now } }));
    ops.push(prisma.wallet.update({ where: { id: parseInt(walletId) }, data: { balance: { increment: walletCredit } } }));
    ops.push(prisma.transaction.create({ data: { userId: parseInt(playerId), type: 'DEPOSIT', amount: new Prisma.Decimal(depositAmt.toString()), status: 'COMPLETED', description: `Deposit via ${walletMethod || wallet.method} - ${walletName || wallet.name}`, notes: `fee:${feeAmt.toFixed(2)}|walletCredit:${walletCredit.toFixed(2)}|amt:${depositAmt.toFixed(2)}|${notes || ''}`, gameId: game.id, paymentMethod: null } }));

    const newStock = game.pointStock - totalGameDeduction;
    const newStatus = newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY';
    ops.push(prisma.game.update({ where: { id: gameId }, data: { pointStock: newStock, status: newStatus } }));

    if (bonusMatch) {
      ops.push(prisma.bonus.create({ data: { userId: parseInt(playerId), type: 'DEPOSIT_MATCH', amount: new Prisma.Decimal(matchAmt.toString()), description: `Match Bonus - 50% of $${depositAmt.toFixed(2)}`, claimed: true, claimedAt: now } }));
      ops.push(prisma.transaction.create({ data: { userId: parseInt(playerId), type: 'BONUS', amount: new Prisma.Decimal(matchAmt.toString()), status: 'COMPLETED', description: `Match Bonus from ${game.name} - 50% of $${depositAmt.toFixed(2)}`, notes: `gameId:${game.id}|From game: ${game.name}|balanceBefore:${balanceBefore}|balanceAfter:${balanceAfter}` } }));
    }

    if (bonusSpecial) {
      ops.push(prisma.bonus.create({ data: { userId: parseInt(playerId), type: 'CUSTOM', amount: new Prisma.Decimal(specialAmt.toString()), description: `Special Bonus - 20% of $${depositAmt.toFixed(2)}`, claimed: true, claimedAt: now } }));
      ops.push(prisma.transaction.create({ data: { userId: parseInt(playerId), type: 'BONUS', amount: new Prisma.Decimal(specialAmt.toString()), status: 'COMPLETED', description: `Special Bonus from ${game.name} - 20% of $${depositAmt.toFixed(2)}`, notes: `gameId:${game.id}|From game: ${game.name}|balanceBefore:${balanceBefore}|balanceAfter:${balanceAfter}` } }));
    }

    if (referralAmt > 0 && referrer) {
      const playerBalBeforeRef = balanceBefore + matchAmt + specialAmt;
      const playerBalAfterRef = playerBalBeforeRef + referralAmt;
      ops.push(prisma.bonus.create({ data: { userId: parseInt(playerId), type: 'REFERRAL', amount: new Prisma.Decimal(referralAmt.toString()), description: `Referral Bonus from ${game.name} — referred by ${referrer.name}`, claimed: true, claimedAt: now } }));
      ops.push(prisma.transaction.create({ data: { userId: parseInt(playerId), type: 'BONUS', amount: new Prisma.Decimal(referralAmt.toString()), status: 'COMPLETED', description: `Referral Bonus from ${game.name} — referred by ${referrer.name}`, notes: `gameId:${game.id}|From game: ${game.name}|balanceBefore:${playerBalBeforeRef.toFixed(2)}|balanceAfter:${playerBalAfterRef.toFixed(2)}` } }));

      const referrerBalBefore = parseFloat(referrer.balance);
      const referrerBalAfter = referrerBalBefore + referralAmt;
      ops.push(prisma.user.update({ where: { id: referrer.id }, data: { balance: { increment: referralAmt } } }));
      ops.push(prisma.bonus.create({ data: { userId: referrer.id, type: 'REFERRAL', amount: new Prisma.Decimal(referralAmt.toString()), description: `Referral Bonus from ${game.name} — ${player.name}'s $${depositAmt.toFixed(2)} deposit`, claimed: true, claimedAt: now } }));
      ops.push(prisma.transaction.create({ data: { userId: referrer.id, type: 'BONUS', amount: new Prisma.Decimal(referralAmt.toString()), status: 'COMPLETED', description: `Referral Bonus from ${game.name} — ${player.name}'s $${depositAmt.toFixed(2)} deposit`, notes: `gameId:${game.id}|From game: ${game.name}|balanceBefore:${referrerBalBefore.toFixed(2)}|balanceAfter:${referrerBalAfter.toFixed(2)}` } }));
    }

    const results = await prisma.$transaction(ops);
    const updatedPlayer = results[0];
    const updatedWallet = results[1];
    const depositTx = results[2];
    const walletBalanceAfter = parseFloat(updatedWallet.balance);

    const bonusesApplied = [];
    if (bonusMatch) bonusesApplied.push(`Match Bonus +$${matchAmt.toFixed(2)}`);
    if (bonusSpecial) bonusesApplied.push(`Special Bonus +$${specialAmt.toFixed(2)}`);
    if (referralAmt > 0 && referrer) bonusesApplied.push(`Referral Bonus +$${referralAmt.toFixed(2)} to both ${player.name} & ${referrer.name}`);

    res.status(201).json({
      success: true,
      message: [`Deposit of $${depositAmt.toFixed(2)} recorded for ${player.name}.`, ...bonusesApplied].join(' '),
      transaction: {
        id: depositTx.id, playerId: player.id, playerName: player.name, type: 'Deposit',
        amount: depositAmt, fee: feeAmt, walletCredit,
        walletId, walletMethod: walletMethod || wallet.method, walletName: walletName || wallet.name,
        walletBalanceBefore, walletBalanceAfter, gameName: game.name,
        balanceBefore, balanceAfter: parseFloat(updatedPlayer.balance),
        status: 'COMPLETED', timestamp: depositTx.createdAt,
        referralBonus: referralAmt > 0 && referrer ? { referrerId: referrer.id, referrerName: referrer.name, amount: referralAmt } : null,
      },
      data: { playerBalance: parseFloat(updatedPlayer.balance), walletBalance: walletBalanceAfter },
    });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Deposit failed: ' + err.message });
  }
});

app.post('/api/transactions/cashout', authMiddleware, async (req, res) => {
  try {
    const { playerId, amount, fee = 0, gameId, walletId, walletMethod, walletName, notes } = req.body;

    if (!playerId || !amount || !walletId) return res.status(400).json({ error: 'playerId, amount and walletId are required' });
    if (!gameId) return res.status(400).json({ error: 'gameId is required for cashouts' });

    const cashoutAmt = parseFloat(amount);
    const feeAmt = parseFloat(fee) || 0;
    if (isNaN(cashoutAmt) || cashoutAmt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

    const player = await prisma.user.findUnique({ where: { id: parseInt(playerId) }, select: { id: true, name: true, balance: true, currentStreak: true, cashoutLimit: true } });
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const balanceBefore = parseFloat(player.balance);
    if (cashoutAmt > balanceBefore) return res.status(400).json({ error: `Insufficient player balance. Has $${balanceBefore.toFixed(2)}, requested $${cashoutAmt.toFixed(2)}.` });

    const wallet = await prisma.wallet.findUnique({ where: { id: parseInt(walletId) }, select: { id: true, name: true, method: true, balance: true } });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    if (cashoutAmt > wallet.balance) return res.status(400).json({ error: `Insufficient wallet balance. Has $${wallet.balance.toFixed(2)}, requested $${cashoutAmt.toFixed(2)}.` });

    const cashoutLimit = parseFloat(player.cashoutLimit ?? 250);
    const streakWaived = (player.currentStreak || 0) >= 30;
    if (cashoutLimit > 0 && !streakWaived) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
      const todayTotal = await prisma.transaction.aggregate({ where: { userId: parseInt(playerId), type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: todayStart, lte: todayEnd } }, _sum: { amount: true } });
      const alreadyCashedOut = parseFloat(todayTotal._sum.amount || 0);
      if (alreadyCashedOut + cashoutAmt > cashoutLimit) {
        const remaining = cashoutLimit - alreadyCashedOut;
        return res.status(400).json({ error: `Daily cashout limit reached. Limit: $${cashoutLimit.toFixed(2)}, remaining: $${remaining.toFixed(2)}.` });
      }
    }

    const game = await prisma.game.findUnique({ where: { id: gameId }, select: { id: true, name: true, pointStock: true } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (cashoutAmt > game.pointStock) return res.status(400).json({ error: `Insufficient game stock. ${game.name} has ${game.pointStock.toFixed(2)} pts.` });

    const balanceAfter = balanceBefore - cashoutAmt;
    const newStock = game.pointStock - cashoutAmt;
    const newGameStatus = newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY';

    const [updatedPlayer, updatedWallet, tx] = await prisma.$transaction([
      prisma.user.update({ where: { id: parseInt(playerId) }, data: { balance: balanceAfter } }),
      prisma.wallet.update({ where: { id: parseInt(walletId) }, data: { balance: { decrement: cashoutAmt + feeAmt } } }),
      prisma.transaction.create({ data: { userId: parseInt(playerId), type: 'WITHDRAWAL', amount: new Prisma.Decimal(cashoutAmt.toString()), status: 'COMPLETED', description: `Cashout via ${walletMethod || wallet.method} - ${walletName || wallet.name}`, notes: `fee:${feeAmt.toFixed(2)}|walletDeducted:${(cashoutAmt + feeAmt).toFixed(2)}|${notes || ''}`, paymentMethod: null, gameId: game.id } }),
      prisma.game.update({ where: { id: game.id }, data: { pointStock: newStock, status: newGameStatus } }),
    ]);

    res.status(201).json({
      success: true,
      message: `Cashout of $${cashoutAmt.toFixed(2)} recorded for ${player.name}.`,
      transaction: {
        id: tx.id, playerId: player.id, playerName: player.name, type: 'Cashout',
        amount: cashoutAmt, walletId, walletMethod: walletMethod || wallet.method,
        walletName: walletName || wallet.name, gameName: null,
        balanceBefore, balanceAfter: parseFloat(updatedPlayer.balance),
        status: 'COMPLETED', timestamp: tx.createdAt,
      },
      data: { playerBalance: parseFloat(updatedPlayer.balance), walletBalance: parseFloat(updatedWallet.balance) },
    });
  } catch (err) {
    console.error('Cashout error:', err);
    res.status(500).json({ error: 'Cashout failed: ' + err.message });
  }
});

app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 10, type = '', status = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {};
    if (type) where.type = type;
    if (status) where.status = status;

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({ where, include: { user: { select: { id: true, name: true, email: true } }, game: { select: { id: true, name: true } } }, skip, take: parseInt(limit), orderBy: { createdAt: 'desc' } }),
      prisma.transaction.count({ where }),
    ]);

    const formatted = transactions.map(t => {
      let type = t.type;
      let bonusType = null;
      if (t.type === 'DEPOSIT') type = 'Deposit';
      else if (t.type === 'WITHDRAWAL') type = 'Cashout';
      else if (t.type === 'BONUS') {
        if (t.description?.includes('Match')) { type = 'Match Bonus'; bonusType = 'match'; }
        else if (t.description?.includes('Special')) { type = 'Special Bonus'; bonusType = 'special'; }
        else if (t.description?.includes('Streak')) { type = 'Streak Bonus'; bonusType = 'streak'; }
        else if (t.description?.includes('Referral')) { type = 'Referral Bonus'; bonusType = 'referral'; }
        else { type = 'Bonus'; }
      }

      let walletMethod = t.paymentMethod || 'Unknown';
      let walletName = 'Account';
      const walletMatch = t.description?.match(/via ([^ ]+) - (.*?)$/);
      if (walletMatch) { walletMethod = walletMatch[1]; walletName = walletMatch[2]; }

      const noteMatch = t.notes?.match(/From game: ([^|]+)(?:\|balanceBefore:([\d.]+)\|balanceAfter:([\d.]+))?/);
      const gameName = noteMatch ? noteMatch[1].trim() : t.game?.name || null;
      const balanceBefore = noteMatch?.[2] ? parseFloat(noteMatch[2]) : null;
      const balanceAfter = noteMatch?.[3] ? parseFloat(noteMatch[3]) : null;
      const feeMatch = t.notes?.match(/^fee:([\d.]+)/);
      const fee = feeMatch ? parseFloat(feeMatch[1]) : null;

      return {
        id: `TXN${String(t.id).padStart(6, '0')}`,
        playerId: t.userId, playerName: t.user?.name || '—', email: t.user?.email || '—',
        type, bonusType, amount: parseFloat(t.amount), fee,
        walletMethod, walletName, gameName, balanceBefore, balanceAfter,
        status: t.status, timestamp: fmtTX(t.createdAt), date: fmtTXDate(t.createdAt),
      };
    });

    res.json({ data: formatted, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.post('/api/transactions/:transactionId/undo', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const transactionId = parseInt(req.params.transactionId);
    console.log(`\n🔄 UNDO: starting for transaction #${transactionId}`);

    const transaction = await prisma.transaction.findUnique({ where: { id: transactionId }, include: { user: { select: { id: true, name: true, balance: true } } } });
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
    if (transaction.status === 'CANCELLED') return res.status(400).json({ error: 'Transaction is already cancelled' });

    let balanceAdjustment = 0;
    if (transaction.type === 'DEPOSIT') balanceAdjustment = -parseFloat(transaction.amount);
    else if (transaction.type === 'WITHDRAWAL') balanceAdjustment = parseFloat(transaction.amount);
    else if (transaction.type === 'BONUS') balanceAdjustment = -parseFloat(transaction.amount);

    const playerBalance = parseFloat(transaction.user.balance) + balanceAdjustment;

    let wallet = null;
    const walletMatch = transaction.description?.match(/via ([^ ]+) - (.+)$/);
    if (walletMatch) {
      wallet = await prisma.wallet.findFirst({ where: { method: walletMatch[1], name: walletMatch[2] } });
    }

    const ops = [
      prisma.user.update({ where: { id: transaction.userId }, data: { balance: playerBalance } }),
      prisma.transaction.update({ where: { id: transactionId }, data: { status: 'CANCELLED' } }),
    ];

    if (wallet) {
      ops.push(prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: transaction.type === 'WITHDRAWAL' ? { increment: parseFloat(transaction.amount) } : { decrement: parseFloat(transaction.amount) } }
      }));
    }

    const gameRestoreMap = {};
    if (transaction.type === 'DEPOSIT' || transaction.type === 'BONUS') {
      const bonusTxns = await prisma.transaction.findMany({
        where: { userId: transaction.userId, type: 'BONUS', status: 'COMPLETED', createdAt: { gte: new Date(transaction.createdAt.getTime() - 10000), lte: new Date(transaction.createdAt.getTime() + 10000) } }
      });

      for (const bonusTx of bonusTxns) {
        const idMatch = bonusTx.notes?.match(/^gameId:([^|]+)\|/);
        if (idMatch) {
          const gId = idMatch[1].trim();
          gameRestoreMap[gId] = (gameRestoreMap[gId] || 0) + parseFloat(bonusTx.amount);
        } else {
          const nameMatch = bonusTx.notes?.match(/From game: (.+)$/);
          if (nameMatch) {
            const g = await prisma.game.findFirst({ where: { name: nameMatch[1].trim() } });
            if (g) gameRestoreMap[g.id] = (gameRestoreMap[g.id] || 0) + parseFloat(bonusTx.amount);
          }
        }
        ops.push(prisma.transaction.update({ where: { id: bonusTx.id }, data: { status: 'CANCELLED' } }));
      }

      for (const [gameId, restoreAmount] of Object.entries(gameRestoreMap)) {
        const game = await prisma.game.findUnique({ where: { id: gameId } });
        if (game) {
          const newStock = parseFloat(game.pointStock) + restoreAmount;
          const newStatus = newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY';
          ops.push(prisma.game.update({ where: { id: game.id }, data: { pointStock: newStock, status: newStatus } }));
        }
      }
    }

    await prisma.$transaction(ops);
    res.json({
      success: true,
      message: `Transaction #${transactionId} reversed successfully`,
      updatedBalances: { playerBalance, walletBalance: wallet ? parseFloat(wallet.balance) + (transaction.type === 'WITHDRAWAL' ? parseFloat(transaction.amount) : -parseFloat(transaction.amount)) : null },
      gamePointsRestored: Object.keys(gameRestoreMap).length > 0 ? gameRestoreMap : null,
    });
  } catch (err) {
    console.error('Undo transaction error:', err);
    res.status(500).json({ error: 'Failed to undo transaction: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GAMES ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/games', authMiddleware, async (req, res) => {
  try {
    const { status, search } = req.query;
    const where = {};
    if (status) where.status = status.toUpperCase();
    if (search) where.name = { contains: search, mode: 'insensitive' };
    const games = await prisma.game.findMany({ where, orderBy: { name: 'asc' } });
    res.json({ data: games });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

app.post('/api/games', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, slug, pointStock, status } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'Name and slug are required' });
    const existing = await prisma.game.findFirst({ where: { OR: [{ name }, { slug }] } });
    if (existing) return res.status(409).json({ error: 'A game with that name or slug already exists' });
    const game = await prisma.game.create({ data: { name: name.trim(), slug: slug.trim(), pointStock: pointStock ?? 0, status: status ?? 'HEALTHY' } });
    res.status(201).json({ data: game, message: 'Game created successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create game' });
  }
});

app.patch('/api/games/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { pointStock, status } = req.body;
    const game = await prisma.game.findUnique({ where: { id } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const updatedGame = await prisma.game.update({ where: { id }, data: { ...(pointStock !== undefined && { pointStock }), ...(status && { status }) } });
    res.json({ data: updatedGame, message: 'Game updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update game' });
  }
});

app.delete('/api/games/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { adminPassword } = req.body;
    if (!adminPassword) return res.status(400).json({ error: 'Admin password is required to delete a game' });
    const actingAdmin = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!actingAdmin) return res.status(403).json({ error: 'Admin not found' });
    const passwordMatch = await bcrypt.compare(adminPassword, actingAdmin.password);
    if (!passwordMatch) return res.status(403).json({ error: 'Incorrect admin password' });
    const game = await prisma.game.findUnique({ where: { id } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    await prisma.game.delete({ where: { id } });
    res.json({ message: `Game "${game.name}" deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete game' });
  }
});

// ═══════════════════════════════════════════════════════════════
// EXPENSES ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/expenses', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { category, search } = req.query;
    const where = {};
    if (category) where.category = category.toUpperCase().replace(' ', '_');
    if (search) where.details = { contains: search, mode: 'insensitive' };
    const expenses = await prisma.expense.findMany({ where, include: { game: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } });
    res.json({ data: expenses });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

app.post('/api/expenses', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { gameId, details, category, amount, pointsAdded, notes } = req.body;
    if (!details || !amount) return res.status(400).json({ error: 'Details and amount are required' });
    const expense = await prisma.expense.create({ data: { gameId: gameId || null, details, category: category?.toUpperCase().replace(' ', '_') || 'POINT_RELOAD', amount: parseFloat(amount), pointsAdded: pointsAdded || 0, notes: notes || null }, include: { game: { select: { id: true, name: true } } } });
    res.status(201).json({ data: expense, message: 'Expense recorded successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

app.patch('/api/expenses/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, category, notes, pointsAdded, paymentMade, walletId } = req.body;
    const expense = await prisma.expense.findUnique({ where: { id } });
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    if (paymentMade !== undefined && walletId) {
      const oldAmount = parseFloat(expense.paymentMade || 0);
      const newAmount = parseFloat(paymentMade);
      const diff = newAmount - oldAmount;
      const wallet = await prisma.wallet.findUnique({ where: { id: parseInt(walletId) } });
      if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
      if (diff > 0 && wallet.balance < diff) return res.status(400).json({ error: `Insufficient wallet balance. Available: $${wallet.balance.toFixed(2)}` });
      const [updatedExpense] = await prisma.$transaction([
        prisma.expense.update({ where: { id }, data: { paymentMade: newAmount, ...(notes !== undefined && { notes }), ...(category && { category: category.toUpperCase().replace(' ', '_') }) } }),
        prisma.wallet.update({ where: { id: parseInt(walletId) }, data: { balance: { decrement: diff } } }),
      ]);
      return res.json({ data: updatedExpense, message: 'Payment updated and wallet adjusted' });
    }

    const updated = await prisma.expense.update({ where: { id }, data: { ...(amount !== undefined && { amount: parseFloat(amount) }), ...(category && { category: category.toUpperCase().replace(' ', '_') }), ...(notes !== undefined && { notes }), ...(pointsAdded !== undefined && { pointsAdded: parseInt(pointsAdded, 10) }) } });
    res.json({ data: updated, message: 'Expense updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

// ═══════════════════════════════════════════════════════════════
// WALLETS ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/wallets', authMiddleware, async (req, res) => {
  try {
    const wallets = await prisma.wallet.findMany({ orderBy: [{ method: 'asc' }, { name: 'asc' }] });
    const grouped = wallets.reduce((acc, wallet) => {
      if (!acc[wallet.method]) acc[wallet.method] = { method: wallet.method, totalBalance: 0, subAccounts: [] };
      acc[wallet.method].subAccounts.push(wallet);
      acc[wallet.method].totalBalance += wallet.balance || 0;
      return acc;
    }, {});
    res.json({ data: Object.values(grouped) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

app.patch('/api/wallets/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { balance, name, identifier } = req.body;
    const wallet = await prisma.wallet.findUnique({ where: { id: parseInt(id) } });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const updated = await prisma.wallet.update({ where: { id: parseInt(id) }, data: { ...(balance !== undefined && { balance: parseFloat(balance) }), ...(name && { name }), ...(identifier !== undefined && { identifier }) } });
    res.json({ data: updated, message: 'Wallet updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update wallet' });
  }
});

app.post('/api/wallets', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, method, identifier, balance } = req.body;
    if (!name || !method) return res.status(400).json({ error: 'Name and method are required' });
    const wallet = await prisma.wallet.create({ data: { name, method, identifier: identifier || null, balance: balance || 0 } });
    res.status(201).json({ data: wallet, message: 'Wallet created' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create wallet' });
  }
});

app.delete('/api/wallets/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await prisma.wallet.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Wallet deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete wallet' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ATTENDANCE ENDPOINT
// ═══════════════════════════════════════════════════════════════

app.get('/api/attendance', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const allPlayers = await prisma.user.findMany({
      where: { role: 'PLAYER' },
      select: { id: true, name: true, username: true, email: true, balance: true, tier: true, status: true },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const twoDaysAgo = new Date(todayStart); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const sevenDaysAgo = new Date(todayStart); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const lastDeposits = await prisma.transaction.groupBy({
      by: ['userId'],
      where: { type: 'DEPOSIT', status: 'COMPLETED', user: { role: 'PLAYER' } },
      _max: { createdAt: true },
    });

    const lastDepositMap = {};
    lastDeposits.forEach(r => { lastDepositMap[r.userId] = r._max.createdAt; });

    const withStatus = allPlayers.map(p => {
      const lastDep = lastDepositMap[p.id];
      let attendanceStatus;
      if (!lastDep) attendanceStatus = 'Inactive';
      else if (lastDep >= todayStart) attendanceStatus = 'Active';
      else if (lastDep >= twoDaysAgo) attendanceStatus = 'Critical';
      else if (lastDep >= sevenDaysAgo) attendanceStatus = 'Highly-Critical';
      else attendanceStatus = 'Inactive';
      return { ...p, attendanceStatus };
    });

    const stats = {
      total: withStatus.length,
      active: withStatus.filter(p => p.attendanceStatus === 'Active').length,
      critical: withStatus.filter(p => p.attendanceStatus === 'Critical').length,
      highlyCritical: withStatus.filter(p => p.attendanceStatus === 'Highly-Critical').length,
      inactive: withStatus.filter(p => p.attendanceStatus === 'Inactive').length,
    };

    const { status } = req.query;
    const statusMap = { 'Active': 'Active', 'Critical': 'Critical', 'Highly-Critical': 'Highly-Critical', 'Inactive': 'Inactive' };
    const filtered = status && statusMap[status] ? withStatus.filter(p => p.attendanceStatus === statusMap[status]) : withStatus;
    const paginated = filtered.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({ data: paginated, stats, pagination: { page: pageNum, limit: limitNum, total: filtered.length, pages: Math.ceil(filtered.length / limitNum) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ISSUES ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/issues', authMiddleware, async (req, res) => {
  try {
    const { status, priority } = req.query;
    const where = {};
    if (status) where.status = status.toUpperCase();
    if (priority) where.priority = priority.toUpperCase();
    const issues = await prisma.issue.findMany({ where: Object.keys(where).length > 0 ? where : undefined, orderBy: { createdAt: 'desc' } });
    res.json({ data: issues });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

app.post('/api/issues', authMiddleware, async (req, res) => {
  try {
    const { title, description, playerName, priority } = req.body;
    if (!title || !description) return res.status(400).json({ error: 'Title and description are required' });
    const issuePriority = priority?.toUpperCase() || 'MEDIUM';
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(issuePriority)) return res.status(400).json({ error: 'Priority must be LOW, MEDIUM, or HIGH' });
    const newIssue = await prisma.issue.create({ data: { title: title.trim(), description: description.trim(), playerName: playerName?.trim() || null, priority: issuePriority, status: 'UNRESOLVED', createdAt: new Date() } });
    res.status(201).json({ data: newIssue, message: 'Issue submitted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create issue' });
  }
});

app.post('/api/issues/:issueId/resolve', authMiddleware, async (req, res) => {
  try {
    const { issueId } = req.params;
    const issue = await prisma.issue.findUnique({ where: { id: parseInt(issueId) } });
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const resolvedIssue = await prisma.issue.update({ where: { id: parseInt(issueId) }, data: { status: 'RESOLVED', updatedAt: new Date() } });
    res.json({ data: resolvedIssue, message: 'Issue marked as resolved' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve issue' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SHIFTS ENDPOINTS
// ═══════════════════════════════════════════════════════════════

async function getOrCreateTeam(teamRole) {
  let team = await prisma.team.findFirst({ where: { teamName: teamRole } });
  if (!team) team = await prisma.team.create({ data: { teamName: teamRole, isShiftActive: false } });
  return team;
}

app.get('/api/shifts/:role', authMiddleware, async (req, res) => {
  try {
    const { role } = req.params;
    const teamShifts = await prisma.shift.findMany({ where: { teamRole: role }, orderBy: { createdAt: 'desc' } });
    if (!teamShifts.length) return res.status(404).json({ error: 'No shifts found for this team' });
    res.json({ data: teamShifts, message: 'Successfully retrieved shift records' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to show shift record' });
  }
});

// ✅ IMPORTANT: /api/shifts/active/:role and /api/shifts/start must be before /api/shifts/:id/...
app.get('/api/shifts/active/:role', authMiddleware, async (req, res) => {
  try {
    const shift = await prisma.shift.findFirst({ where: { teamRole: req.params.role, isActive: true }, orderBy: { startTime: 'desc' } });
    res.json({ data: shift || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get active shift' });
  }
});

app.post('/api/shifts/start', authMiddleware, async (req, res) => {
  try {
    const { teamRole } = req.body;
    if (!teamRole) return res.status(400).json({ error: 'teamRole is required' });
    await prisma.shift.updateMany({ where: { teamRole, isActive: true }, data: { isActive: false, endTime: new Date() } });
    const team = await getOrCreateTeam(teamRole);
    await prisma.team.update({ where: { id: team.id }, data: { isShiftActive: true } });
    const shift = await prisma.shift.create({ data: { teamId: team.id, teamRole, startTime: new Date(), isActive: true } });
    res.status(201).json({ data: shift, message: 'Shift started' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start shift: ' + err.message });
  }
});

app.patch('/api/shifts/:id/end', authMiddleware, async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const existing = await prisma.shift.findUnique({ where: { id: shiftId } });
    if (!existing) return res.status(404).json({ error: 'Shift not found' });
    const now = new Date();
    const duration = Math.round((now - new Date(existing.startTime)) / 60000);
    const [updated] = await prisma.$transaction([
      prisma.shift.update({ where: { id: shiftId }, data: { endTime: now, duration, isActive: false } }),
      prisma.team.updateMany({ where: { teamName: existing.teamRole }, data: { isShiftActive: false } }),
    ]);
    res.json({ data: updated, message: 'Shift ended' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to end shift: ' + err.message });
  }
});

app.post('/api/shifts/:id/checkin', authMiddleware, async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const { confirmedBalance, balanceNote } = req.body;
    const checkin = await prisma.shiftCheckin.upsert({
      where: { shiftId },
      create: { shiftId, userId: req.userId, confirmedBalance: parseFloat(confirmedBalance), balanceNote, balanceConfirmedAt: new Date(), status: 'BALANCE_CONFIRMED' },
      update: { confirmedBalance: parseFloat(confirmedBalance), balanceNote, balanceConfirmedAt: new Date(), status: 'BALANCE_CONFIRMED' }
    });
    broadcastTaskUpdate('shift_checkin', { shiftId, checkin });
    res.json({ data: checkin, message: 'Balance confirmed. Shift started!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shifts/:id/checkout', authMiddleware, async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const { effortRating, workSummary, issuesEncountered, shoutouts, additionalNotes } = req.body;
    if (!effortRating || effortRating < 1 || effortRating > 5) return res.status(400).json({ error: 'Effort rating must be 1-5' });
    const checkin = await prisma.shiftCheckin.upsert({
      where: { shiftId },
      create: { shiftId, userId: req.userId, effortRating: parseInt(effortRating), workSummary, issuesEncountered, shoutouts, additionalNotes, endFormSubmittedAt: new Date(), status: 'COMPLETED' },
      update: { effortRating: parseInt(effortRating), workSummary, issuesEncountered, shoutouts, additionalNotes, endFormSubmittedAt: new Date(), status: 'COMPLETED' }
    });
    broadcastTaskUpdate('shift_checkout', { shiftId, checkin });
    res.json({ data: checkin, message: 'Shift summary submitted!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shifts/:id/checkin', authMiddleware, async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const checkin = await prisma.shiftCheckin.findUnique({ where: { shiftId }, include: { user: { select: { id: true, name: true, role: true } } } });
    res.json({ data: checkin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// REPORTS ENDPOINTS
// ═══════════════════════════════════════════════════════════════

function sumField(arr, field) { return arr.reduce((s, r) => s + parseFloat(r[field] || 0), 0); }
function f2(n) { return parseFloat(n.toFixed(2)); }
const BONUS_TYPES = ['BONUS', 'MATCH_BONUS', 'SPECIAL'];

async function enrichShift(shift) {
  const shiftEnd = shift.endTime || new Date();
  const timeWindow = { gte: new Date(shift.startTime), lte: new Date(shiftEnd) };

  const [transactions, tasks, playersAdded, bonusesGranted, issueActivity, checkin] = await Promise.all([
    prisma.transaction.findMany({ where: { createdAt: timeWindow, status: 'COMPLETED' }, include: { user: { select: { id: true, name: true } }, game: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } }),
    prisma.task.findMany({ where: { completedAt: timeWindow, status: 'COMPLETED' }, include: { assignedTo: { select: { id: true, name: true, role: true } }, subTasks: true, progressLogs: { include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } } } }).catch(() => []),
    prisma.user.findMany({ where: { role: 'PLAYER', createdAt: timeWindow }, select: { id: true, name: true, username: true, tier: true, createdAt: true } }).catch(() => []),
    prisma.transaction.findMany({ where: { type: { in: ['BONUS', 'MATCH_BONUS', 'SPECIAL'] }, status: 'COMPLETED', createdAt: timeWindow }, include: { user: { select: { id: true, name: true } }, game: { select: { id: true, name: true } } } }).catch(() => []),
    prisma.issue.findMany({ where: { OR: [{ createdAt: timeWindow }, { updatedAt: timeWindow, status: 'RESOLVED' }] } }).catch(() => []),
    prisma.shiftCheckin.findUnique({ where: { shiftId: shift.id }, include: { user: { select: { id: true, name: true } } } }).catch(() => null),
  ]);

  const deposits = transactions.filter(t => t.type === 'DEPOSIT');
  const cashouts = transactions.filter(t => t.type === 'WITHDRAWAL');
  const bonusTxns = transactions.filter(t => ['BONUS', 'MATCH_BONUS', 'SPECIAL'].includes(t.type));
  const sum = (arr, field) => arr.reduce((s, r) => s + parseFloat(r[field] || 0), 0);

  const totalDeposits = sum(deposits, 'amount');
  const totalCashouts = sum(cashouts, 'amount');
  const totalBonuses = sum(bonusTxns, 'amount');

  const playerMap = {};
  deposits.forEach(t => {
    if (!playerMap[t.userId]) playerMap[t.userId] = { name: t.user?.name || `Player #${t.userId}`, total: 0, count: 0 };
    playerMap[t.userId].total += parseFloat(t.amount || 0);
    playerMap[t.userId].count += 1;
  });

  return {
    ...shift, checkin,
    stats: {
      tasksCompleted: tasks.length, playersAdded: playersAdded.length,
      bonusesGranted: bonusesGranted.length, totalBonusAmount: f2(sum(bonusesGranted, 'amount')),
      depositCount: deposits.length, cashoutCount: cashouts.length,
      totalDeposits: f2(totalDeposits), totalCashouts: f2(totalCashouts), totalBonuses: f2(totalBonuses),
      netProfit: f2(totalDeposits - totalCashouts - totalBonuses),
      transactionCount: transactions.length,
      issuesCreated: issueActivity.filter(i => new Date(i.createdAt) >= new Date(shift.startTime)).length,
      issuesResolved: issueActivity.filter(i => i.status === 'RESOLVED' && new Date(i.updatedAt) >= new Date(shift.startTime)).length,
      effortRating: checkin?.effortRating || null, confirmedBalance: checkin?.confirmedBalance || null,
    },
    tasks, transactions, playersAdded, bonusesGranted, issueActivity,
    playerDepositBreakdown: Object.values(playerMap).sort((a, b) => b.total - a.total),
  };
}

app.get('/api/reports/daily', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { date, teamRole } = req.query;
    const target = date ? new Date(date) : new Date();
    const dayStart = new Date(target); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(target); dayEnd.setUTCHours(23, 59, 59, 999);

    const shiftWhere = { startTime: { gte: dayStart, lte: dayEnd } };
    if (teamRole) shiftWhere.teamRole = teamRole;

    const shifts = await prisma.shift.findMany({ where: shiftWhere, orderBy: { startTime: 'asc' } });
    const enrichedShifts = await Promise.all(shifts.map(enrichShift));

    const roles = teamRole ? [teamRole] : ['TEAM1', 'TEAM2', 'TEAM3', 'TEAM4'];
    const teamUsers = await prisma.user.findMany({ where: { role: { in: roles } }, select: { id: true, name: true, username: true, role: true } });

    const teams = roles.map(role => ({ role, member: teamUsers.find(u => u.role === role) || null, shifts: enrichedShifts.filter(s => s.teamRole === role) }));

    const allDayTxns = await prisma.transaction.findMany({ where: { createdAt: { gte: dayStart, lte: dayEnd }, status: 'COMPLETED' } });
    const dayDeposits = sumField(allDayTxns.filter(t => t.type === 'DEPOSIT'), 'amount');
    const dayCashouts = sumField(allDayTxns.filter(t => t.type === 'WITHDRAWAL'), 'amount');
    const dayBonuses = sumField(allDayTxns.filter(t => BONUS_TYPES.includes(t.type)), 'amount');

    const dayTasks = await prisma.task.findMany({ where: { completedAt: { gte: dayStart, lte: dayEnd }, status: 'COMPLETED' }, include: { assignedTo: { select: { id: true, name: true, role: true } }, createdBy: { select: { id: true, name: true } } } }).catch(() => []);
    const wallets = await prisma.wallet.findMany({ orderBy: [{ method: 'asc' }, { name: 'asc' }] });

    res.json({
      date: dayStart.toISOString().split('T')[0], teams,
      wallets: wallets.map(w => ({ id: w.id, name: w.name, method: w.method, balance: parseFloat(w.balance) })),
      dayTasks,
      summary: { totalDeposits: f2(dayDeposits), totalCashouts: f2(dayCashouts), totalBonuses: f2(dayBonuses), netProfit: f2(dayDeposits - dayCashouts - dayBonuses), totalShifts: enrichedShifts.length, activeShifts: enrichedShifts.filter(s => s.isActive).length, tasksCompleted: dayTasks.length, transactionCount: allDayTxns.length },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report: ' + err.message });
  }
});

app.get('/api/reports/my-shifts', authMiddleware, async (req, res) => {
  try {
    const role = req.query.role || req.userRole;
    const limit = parseInt(req.query.limit) || 30;
    const shifts = await prisma.shift.findMany({ where: { teamRole: role }, orderBy: { startTime: 'desc' }, take: limit });
    const enriched = await Promise.all(shifts.map(enrichShift));
    res.json({ data: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch shift reports' });
  }
});

// ═══════════════════════════════════════════════════════════════
// CHARTS ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/chart/daily-profit', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const chartData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(); date.setDate(date.getDate() - i); date.setHours(0, 0, 0, 0);
      const nextDate = new Date(date); nextDate.setDate(nextDate.getDate() + 1);
      const [deposits, withdrawals] = await Promise.all([
        prisma.transaction.aggregate({ where: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: date, lt: nextDate } }, _sum: { amount: true } }),
        prisma.transaction.aggregate({ where: { type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: date, lt: nextDate } }, _sum: { amount: true } }),
      ]);
      const profit = parseFloat(deposits._sum.amount || 0) - parseFloat(withdrawals._sum.amount || 0);
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      chartData.push({ day: dayNames[date.getDay()], profit: Math.round(profit) });
    }
    res.json({ data: chartData });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch daily profit data' });
  }
});

app.get('/api/chart/player-activity', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const chartData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(); date.setDate(date.getDate() - i); date.setHours(0, 0, 0, 0);
      const nextDate = new Date(date); nextDate.setDate(nextDate.getDate() + 1);
      const deposits = await prisma.transaction.aggregate({ where: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: date, lt: nextDate } }, _sum: { amount: true } });
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      chartData.push({ name: dayNames[date.getDay()], deposits: Math.round(parseFloat(deposits._sum.amount || 0)) });
    }
    res.json({ data: chartData });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch player activity data' });
  }
});

app.get('/api/chart/player-deposit-withdrawal', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const getChartData = async (days) => {
      const chartData = [];
      for (let i = days - 1; i >= 0; i--) {
        const date = new Date(); date.setDate(date.getDate() - i); date.setHours(0, 0, 0, 0);
        const nextDate = new Date(date); nextDate.setDate(nextDate.getDate() + 1);
        const [deposits, withdrawals] = await Promise.all([
          prisma.transaction.aggregate({ where: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: date, lt: nextDate } }, _sum: { amount: true } }),
          prisma.transaction.aggregate({ where: { type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: date, lt: nextDate } }, _sum: { amount: true } }),
        ]);
        chartData.push({ date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), deposits: parseFloat(deposits._sum.amount || 0), withdrawals: parseFloat(withdrawals._sum.amount || 0) });
      }
      return chartData;
    };
    const [period_7days, period_30days] = await Promise.all([getChartData(7), getChartData(30)]);
    res.json({ period_7days, period_30days });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch player activity data' });
  }
});

// ═══════════════════════════════════════════════════════════════
// TASK ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// ── SSE client registry ─────────────────────────────────────────
const sseClients = new Map(); // Map<userId, Set<res>>

// ── ✅ FIXED: broadcastTaskUpdate now uses sseClients (was using undefined `clients`) ─
function broadcastTaskUpdate(eventType, data) {
  const payload = `data: ${JSON.stringify({ type: eventType, data })}\n\n`;
  for (const clients of sseClients.values()) {
    for (const res of clients) {
      try { res.write(payload); } catch (_) { /* skip dead connections */ }
    }
  }
}

// ── Shared helper: increment task progress ───────────────────────
async function incrementTaskProgress(taskId, userId, value, action, metadata = {}) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { subTasks: true } });
  if (!task) return null;

  await prisma.taskProgressLog.create({ data: { taskId, userId, action, value, metadata } });

  const newVal = (task.currentValue || 0) + value;
  const isDone = task.targetValue && newVal >= task.targetValue;

  const sub = task.subTasks?.find(st => st.assignedToId === userId);
  if (sub) {
    const newSubVal = (sub.currentValue || 0) + value;
    const subDone = sub.targetValue && newSubVal >= sub.targetValue;
    await prisma.subTask.update({
      where: { id: sub.id },
      data: { currentValue: newSubVal, status: subDone ? 'COMPLETED' : 'IN_PROGRESS', completedAt: subDone ? new Date() : undefined }
    });
  }

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: { currentValue: newVal, status: isDone ? 'COMPLETED' : 'IN_PROGRESS', completedAt: isDone ? new Date() : undefined },
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
      assignedTo: { select: { id: true, name: true, role: true } },
      subTasks: { include: { assignedTo: { select: { id: true, name: true } } } },
      progressLogs: { include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 20 }
    }
  });

  broadcastTaskUpdate('task_updated', updated);
  return updated;
}

// ── SSE handshake ────────────────────────────────────────────────
// ✅ IMPORTANT: This MUST be before /api/tasks/:id or Express will match
// "events" as an :id param and never reach this handler.
app.get('/api/tasks/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let userId;
  try {
    const token = req.cookies?.token || req.headers?.authorization?.replace('Bearer ', '');
    if (!token) throw new Error('No token');
    const decoded = jwt.verify(token, JWT_SECRET);
    // userId = decoded.id || decoded.userId;
    userId = decoded.userId;

    if (!userId) throw new Error('No userId in token');
  } catch (err) {
    res.write('event: auth_error\ndata: {"error":"Unauthorized"}\n\n');
    res.end();
    return;
  }

  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);

  res.write('event: connected\ndata: {"ok":true}\n\n');

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.get(userId)?.delete(res);
    if (sseClients.get(userId)?.size === 0) sseClients.delete(userId);
  });
});

// ── Online presence ──────────────────────────────────────────────
const onlineUsers = new Map();

app.post('/api/tasks/ping', authMiddleware, (req, res) => {
  onlineUsers.set(req.userId, Date.now());
  res.json({ ok: true });
});

app.get('/api/tasks/online', authMiddleware, adminMiddleware, (req, res) => {
  const threshold = Date.now() - 45000;
  const online = [];
  for (const [uid, ts] of onlineUsers.entries()) { if (ts >= threshold) online.push(uid); }
  res.json({ data: online });
});

// ── Daily reset ──────────────────────────────────────────────────
// ✅ Must be before /api/tasks/:id
app.post('/api/tasks/daily-reset', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const dailyTasks = await prisma.task.findMany({ where: { isDaily: true, taskType: 'DAILY_CHECKLIST' } });
    await Promise.all(dailyTasks.map(t => {
      const resetItems = (t.checklistItems || []).map(item => ({ ...item, done: false, completedBy: null, completedAt: null }));
      return prisma.task.update({ where: { id: t.id }, data: { checklistItems: resetItems, status: 'PENDING', completedAt: null, currentValue: 0, dailyResetAt: new Date() } });
    }));
    res.json({ message: `Reset ${dailyTasks.length} daily tasks` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tasks ───────────────────────────────────────────────
app.get('/api/tasks', authMiddleware, async (req, res) => {
  try {
    const { assignedToId, taskType, status, myTasks } = req.query;
    const where = {};
    if (taskType) where.taskType = taskType;
    if (status) where.status = status;
    if (myTasks === 'true') {
      where.OR = [{ assignedToId: req.userId }, { assignToAll: true }];
    } else if (assignedToId) {
      where.assignedToId = parseInt(assignedToId);
    }

    const tasks = await prisma.task.findMany({
      where,
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        assignedTo: { select: { id: true, name: true, role: true } },
        subTasks: { include: { assignedTo: { select: { id: true, name: true, role: true } } }, orderBy: { id: 'asc' } },
        progressLogs: { include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }
      },
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }]
    });

    res.json({ data: tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tasks ──────────────────────────────────────────────
app.post('/api/tasks', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const {
      title, description, priority, dueDate, notes,
      taskType = 'STANDARD', assignToAll = false, assignedToId,
      targetValue, checklistItems, subTasks, isDaily,
    } = req.body;

    const baseData = {
      title, description, priority: (priority || 'MEDIUM').toUpperCase(),
      dueDate: dueDate ? new Date(dueDate) : null, notes,
      createdById: req.userId, status: 'PENDING', taskType,
      targetValue: targetValue ? parseFloat(targetValue) : null,
      currentValue: 0, assignToAll: !!assignToAll,
      checklistItems: checklistItems?.length
        ? checklistItems.map((item, i) => ({ id: `item_${Date.now()}_${i}`, label: item.label, required: !!item.required, done: false, completedBy: null, completedAt: null }))
        : null,
      isDaily: !!isDaily,
    };
if (true) { // <- wrapper so this file is valid JS; remove when copying
 if (assignToAll) {
      const members = await prisma.user.findMany({
        where: { role: { in: ['TEAM1', 'TEAM2', 'TEAM3', 'TEAM4'] } },
      });

      if (!members.length) {
        return res.status(400).json({ error: 'No team members found to assign task to' });
      }

      const created = await Promise.all(
        members.map(m =>
          prisma.task.create({
            data: { ...baseData, assignedToId: m.id },
            include: {
              createdBy: { select: { id: true, name: true, role: true } },
              assignedTo: { select: { id: true, name: true, role: true } },
              subTasks: { include: { assignedTo: { select: { id: true, name: true } } } },
              progressLogs: { include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 10 },
            },
          })
        )
      );

      created.forEach(t => broadcastTaskUpdate('task_created', t));
      return res.status(201).json({ data: created[0], message: `Task assigned to ${created.length} members` });
    }
}

    const task = await prisma.task.create({
      data: { ...baseData, assignedToId: assignedToId ? parseInt(assignedToId) : null },
      include: { createdBy: { select: { id: true, name: true, role: true } }, assignedTo: { select: { id: true, name: true, role: true } } }
    });

    if (subTasks?.length) {
      await prisma.subTask.createMany({ data: subTasks.map(st => ({ taskId: task.id, assignedToId: st.assignedToId ? parseInt(st.assignedToId) : null, label: st.label || '', targetValue: st.targetValue ? parseFloat(st.targetValue) : null, currentValue: 0, status: 'PENDING' })) });
    }

    broadcastTaskUpdate('task_created', task);
    res.status(201).json({ data: task, message: 'Task created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tasks/:id/progress ─────────────────────────────────
app.post('/api/tasks/:id/progress', authMiddleware, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { value = 1, action = 'PROGRESS_LOGGED', metadata = {} } = req.body;
    const updated = await incrementTaskProgress(taskId, req.userId, parseFloat(value), action, metadata);
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    res.json({ data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/tasks/:id/checklist ───────────────────────────────
app.patch('/api/tasks/:id/checklist', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { itemId, done } = req.body;
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const items = (task.checklistItems || []).map(item =>
      item.id === itemId
        ? { ...item, done: !!done, completedBy: done ? req.userId : null, completedAt: done ? new Date().toISOString() : null }
        : item
    );

    const requiredAll = items.filter(i => i.required).every(i => i.done);
    const anyDone = items.some(i => i.done);

    const updated = await prisma.task.update({
      where: { id },
      data: { checklistItems: items, status: requiredAll ? 'COMPLETED' : anyDone ? 'IN_PROGRESS' : 'PENDING', completedAt: requiredAll ? new Date() : null },
      include: { createdBy: { select: { id: true, name: true, role: true } }, assignedTo: { select: { id: true, name: true, role: true } } }
    });

    broadcastTaskUpdate('task_updated', updated);
    res.json({ data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/tasks/:id ─────────────────────────────────────────
app.patch('/api/tasks/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, notes, priority, title, description, dueDate } = req.body;
    const updateData = {};
    if (status) { updateData.status = status.toUpperCase(); if (status.toUpperCase() === 'COMPLETED') updateData.completedAt = new Date(); if (status.toUpperCase() === 'PENDING') updateData.completedAt = null; }
    if (notes !== undefined) updateData.notes = notes;
    if (priority) updateData.priority = priority.toUpperCase();
    if (title) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (dueDate) updateData.dueDate = new Date(dueDate);

    const updated = await prisma.task.update({
      where: { id }, data: updateData,
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        assignedTo: { select: { id: true, name: true, role: true } },
        subTasks: { include: { assignedTo: { select: { id: true, name: true } } } },
        progressLogs: { include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 20 }
      }
    });

    broadcastTaskUpdate('task_updated', updated);
    res.json({ data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/tasks/:id ────────────────────────────────────────
app.delete('/api/tasks/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.task.delete({ where: { id } });
    broadcastTaskUpdate('task_deleted', { id });
    res.json({ message: 'Task deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/team-members ────────────────────────────────────────
app.get('/api/team-members', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const members = await prisma.user.findMany({
      where: { role: { in: ['TEAM1', 'TEAM2', 'TEAM3', 'TEAM4'] } },
      select: { id: true, name: true, username: true, role: true, email: true },
      orderBy: { name: 'asc' },
    });
    res.json({ data: members });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => { res.json({ status: 'ok', timestamp: new Date() }); });

// ═══════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`✅ OceanBets server running at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

export default app;
