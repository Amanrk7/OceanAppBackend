/**
 * OceanBets Dashboard Backend Server
  * Complete implementation for frontend dashboard
    * 
 * This server provides all the API endpoints your frontend needs
  */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
// import { PrismaClient } from '@prisma/client';
import { PrismaClient, Prisma } from '@prisma/client';
// import { data } from 'autoprefixer';

dotenv.config();
const TX_TZ = 'America/Chicago'; // Texas Central Time (handles DST automatically)

/** Short date in Texas CT:  "Jan 15, 2025" */
function fmtTXDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', {
    timeZone: TX_TZ,
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/** Full datetime in Texas CT:  "Jan 15, 2025, 3:42 PM" */
function fmtTX(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-US', {
    timeZone: TX_TZ,
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
const prisma = new PrismaClient();

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Initialize Express
const app = express();

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ═══════════════════════════════════════════════════════════════
// BACKEND: AUTHORITATIVE UTC TIME ENDPOINT
// ═══════════════════════════════════════════════════════════════

app.get("/api/time", (req, res) => {
  const serverTime = Date.now(); // millisecond-accurate timestamp
  res.json({
    timestamp: serverTime,  // Unix timestamp (ms)
    iso: new Date().toISOString(), // ISO 8601 for logging
    timezone: "UTC",
  });
});


// ═══════════════════════════════════════════════════════════════
// AUTHENTICATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

const authMiddleware = (req, res, next) => {
  try {
    const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized - No token' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
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
// -------------------------------------- AUTH ENDPOINTS ------------
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/login
 * Authenticate user and return JWT token
 */

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { username }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // ✅ CORRECT - Use bcrypt to verify hashed password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Account suspended or banned' });
    }

    // Create JWT token
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: user.role,
        balance: user.balance,
        tier: user.tier
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/logout
 * Clear authentication token
 */
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out' });
});



// ═══════════════════════════════════════════════════════════════
// -------------------------- USERS/PLAYERS ENDPOINTS -------------------
// ═══════════════════════════════════════════════════════════════
/**
 * GET /api/user
 * Get current authenticated user
 */
app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        balance: true,
        tier: true,
        totalWagered: true,
        totalWon: true,
        gamesPlayed: true,
        createdAt: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * GET /api/players
 * Get all players with pagination and filtering
 */
app.get('/api/players', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', status = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let where = { role: 'PLAYER' };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } }
      ];
    }

    if (status) where.status = status;

    // ✅ Run both queries in parallel — players AND total count
    const [players, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          phone: true,
          status: true,
          balance: true,
          tier: true,
          tierPoints: true,
          gamesPlayed: true,
          winStreak: true,
          currentStreak: true,
          playTimeMinutes: true,
          lastPlayedDate: true,
          cashoutLimit: true,
          source: true,
          facebook: true,
          telegram: true,
          instagram: true,
          twitterX: true,
          snapchat: true,
          createdAt: true,
          lastLoginAt: true,
          bonuses: {
            where: { claimed: false },
            select: { amount: true }
          },
          referrals: {
            select: { id: true }
          }
        },
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
      }),
      prisma.user.count({ where })  // ✅ this is what was missing
    ]);

    const formatted = players.map(p => ({
      id: p.id,
      name: p.name,
      email: p.email,
      phone: p.phone,
      status: p.status,
      balance: parseFloat(p.balance),
      tier: p.tier,
      tierPoints: p.tierPoints,
      cashoutLimit: parseFloat(p.cashoutLimit || 250),
      source: p.source,
      attendance: p.status === 'ACTIVE' ? 'active'
        : p.status === 'CRITICAL' ? 'critical'
          : p.status === 'HIGHLY_CRITICAL' ? 'highly-critical'
            : 'inactive',
      // streak: {
      //   currentStreak: p.currentStreak || 0,
      //   lastPlayedDate: p.lastPlayedDate,
      // }, 
      streak: {
        currentStreak: p.currentStreak || 0,
        lastPlayedDate: p.lastPlayedDate,
        streakBonus: p.currentStreak >= 7 ? 10.00   // example: $10 bonus at 7-day streak
          : p.currentStreak >= 3 ? 5.00    // $5 bonus at 3-day streak
            : 0,
      },
      tierProgress: {
        currentTier: p.tier,
        playTimeMinutes: p.playTimeMinutes || 0,
      },
      socials: {
        email: p.email,
        phone: p.phone,
        facebook: p.facebook,
        telegram: p.telegram,
        instagram: p.instagram,
        x: p.twitterX,
        snapchat: p.snapchat,
      },
      bonusTracker: {
        availableBonus: p.bonuses.reduce((sum, b) => sum + parseFloat(b.amount), 0),
      },
      referralsList: p.referrals.map(r => r.id),
      lastLoginAt: fmtTX(p.lastLoginAt),
      createdAt: fmtTXDate(p.createdAt),
    }));

    res.json({
      data: formatted,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,   // ✅ now properly defined
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (err) {
    console.error('Get players error:', err);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});


// ── Shared constants ──────────────────────────────────────────
const TIER_CASHOUT = { BRONZE: 250, SILVER: 500, GOLD: 750 };

// Maps DB UserStatus → attendance string used by PlayerDashboard
const statusToAttendance = (status) => {
  const map = {
    ACTIVE: 'active',
    CRITICAL: 'critical',
    HIGHLY_CRITICAL: 'highly-critical',
    INACTIVE: 'inactive',
  };
  return map[status] || 'active';
};

// Shape a raw Prisma user row → the nested structure PlayerDashboard expects
function shapePlayer(user) {
  const tierReqs = { BRONZE: 6000, SILVER: 12000, GOLD: null };
  const nextReq = tierReqs[user.tier];
  const progressPct = nextReq
    ? Math.min(100, Math.round((user.playTimeMinutes / nextReq) * 100))
    : 100;

  const claimed = (user.bonuses || []).filter(b => b.claimed);
  const unclaimed = (user.bonuses || []).filter(b => !b.claimed);
  const totalBonusEarned = claimed.reduce((s, b) => s + parseFloat(b.amount), 0);
  const usedBonus = claimed.reduce((s, b) => s + parseFloat(b.wagerMet || 0), 0);
  const availableBonus = unclaimed.reduce((s, b) => s + parseFloat(b.amount), 0);

  const referralsList = (user.referrals || []).map(r => ({
    id: r.id, name: r.name, username: r.username,
  }));
  const friendsList = [...(user.friends || []), ...(user.friendOf || [])].map(f => ({
    id: f.id, name: f.name, username: f.username,
  }));

  // ── Transaction history (last 30 days) ───────────────────────────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const transactionHistory = (user.transactions || [])
    .filter(t => new Date(t.createdAt) >= thirtyDaysAgo)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(t => {
      // ── Determine type label ─────────────────────────────────────────────
      let type = 'other';
      const desc = t.description || '';

      if (t.type === 'DEPOSIT') type = 'deposit';
      else if (t.type === 'WITHDRAWAL') type = 'cashout';
      else if (t.type === 'REFERRAL') type = 'Referral Bonus';
      else if (t.type === 'BONUS') {
        // Parse subtype from description text
        if (desc.includes('Streak Bonus')) type = 'Streak Bonus';
        else if (desc.includes('Referral Bonus')) type = 'Referral Bonus';
        else if (desc.includes('Match Bonus')) type = 'Match Bonus';
        else if (desc.includes('Special Bonus')) type = 'Special Bonus';
        else if (desc.startsWith('Bonus from')) type = 'Bonus';
        else type = 'bonus_credited';
      }

      // ── Extract wallet info ──────────────────────────────────────────────
      // Description format: "Deposit via PAYPAL - Main Account"
      const walletMatch = desc.match(/via ([^ ]+) - (.+)$/);
      const walletMethod = walletMatch?.[1] || null;
      const walletName = walletMatch?.[2] || null;

      // ── Extract game name ────────────────────────────────────────────────
      let gameName = null;
      // New format in description: "Streak Bonus from GameName — notes"
      const fromGameDesc = desc.match(/^(?:Streak Bonus|Referral Bonus|Match Bonus|Special Bonus|Bonus) from ([^—\n]+?)(?:\s*—|$)/);
      if (fromGameDesc) gameName = fromGameDesc[1].trim();
      // Notes format: "gameId:xxx|From game: GameName"  OR  "From game: GameName"
      if (!gameName) {
        const noteGameMatch = (t.notes || '').match(/From game: ([^\|]+?)(?:\||$)/);
        if (noteGameMatch) gameName = noteGameMatch[1].trim();
      }

      return {
        id: t.id,
        type,
        amount: parseFloat(t.amount),
        status: t.status,
        walletMethod,
        walletName,
        gameName,
        // date: new Date(t.createdAt).toLocaleDateString('en-US', {
        //   month: 'short', day: 'numeric', year: 'numeric',
        // }),
        date: fmtTXDate(t.createdAt),
      };
    });

  const streakBonus = (user.currentStreak || 0) * 0.5;

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    phone: user.phone || null,
    tier: user.tier,
    status: user.status,
    attendance: statusToAttendance(user.status),
    balance: parseFloat(user.balance),
    cashoutLimit: parseFloat(user.cashoutLimit),
    source: user.source || '—',
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,

    socials: {
      email: user.email,
      phone: user.phone || null,
      facebook: user.facebook || null,
      telegram: user.telegram || null,
      instagram: user.instagram || null,
      x: user.twitterX || null,
      snapchat: user.snapchat || null,
    },

    // ✅ NEW: who referred this player (from the included `referrer` relation)
    referredBy: user.referrer
      ? { id: user.referrer.id, name: user.referrer.name, username: user.referrer.username }
      : null,

    streak: {
      currentStreak: user.currentStreak || 0,
      streakBonus,
      // lastPlayedDate: user.lastPlayedDate
      //   ? new Date(user.lastPlayedDate).toLocaleDateString('en-US', {
      //     month: 'short', day: 'numeric', year: 'numeric',
      //   })
      //   : '—',
      lastPlayedDate: fmtTXDate(user.lastPlayedDate),
    },

    tierProgress: {
      playTimeMinutes: user.playTimeMinutes || 0,
      progressPercentage: progressPct,
      nextTierRequirement: nextReq,
    },

    bonusTracker: { availableBonus, totalBonusEarned, usedBonus },
    referralsList,
    friendsList,
    transactionHistory,
  };
}

// ══════════════════════════════════════════════════════════════
// 1.  POST /api/create-new-player
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// PATCH B  ──  Add GET /api/players/search
//
// Paste this NEW ROUTE anywhere BEFORE the wildcard error handler at the bottom
// of index.js (e.g. right after the GET /api/players/:id route).
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/players/search', authMiddleware, async (req, res) => {
  try {
    const { q = '' } = req.query;

    // Require at least 2 chars so we don't hammer the DB on every keystroke
    if (q.trim().length < 2) {
      return res.json({ data: [] });
    }

    const players = await prisma.user.findMany({
      where: {
        role: 'PLAYER',
        OR: [
          { name: { contains: q.trim(), mode: 'insensitive' } },
          { username: { contains: q.trim(), mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        name: true,
        username: true,
        tier: true,
        status: true,
        balance: true,
      },
      orderBy: { name: 'asc' },
      take: 10,
    });

    res.json({ data: players });
  } catch (err) {
    console.error('Player search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// PATCH C  ──  Replace POST /api/create-new-player
//
// This version adds:
//   • Accepts `initialDeposit` in the request body
//   • If a referrer is linked AND initialDeposit > 0, automatically credits the
//     referrer with a REFERRAL bonus = initialDeposit / 2, debiting the game
//     stock from `gameId` (optional — only if gameId is supplied).
//   • Falls back gracefully if no game is provided (bonus is still recorded,
//     no game stock is touched).
// ══════════════════════════════════════════════════════════════════════════════

// app.post('/api/create-new-player', authMiddleware, async (req, res) => {
//   try {
//     const {
//       username, password, email, name, phone, tier,
//       facebook, telegram, instagram, x, snapchat,
//       referrals, friends, sources,
//       initialDeposit,   // ← NEW: optional first-deposit amount used for referrer bonus
//       gameId,           // ← NEW: optional game to deduct referrer-bonus stock from
//     } = req.body;

//     if (!username || !password || !email || !name) {
//       return res.status(400).json({ error: 'Name, username, password, and email are required' });
//     }

//     const existing = await prisma.user.findFirst({
//       where: { OR: [{ username }, { email }] },
//     });
//     if (existing) {
//       return res.status(409).json({ error: 'Username or email already exists' });
//     }

//     const hashedPassword = await bcrypt.hash(password, 10);
//     const resolvedTier = tier || 'BRONZE';

//     // Normalise string-or-array inputs
//     const toArray = (val) => {
//       if (Array.isArray(val)) return val.filter(Boolean);
//       if (typeof val === 'string' && val.trim()) return val.split(',').map(s => s.trim()).filter(Boolean);
//       return [];
//     };

//     const referralList = toArray(referrals);
//     const friendList = toArray(friends);
//     const sourceList = toArray(sources);

//     // ── 1. Create the player ─────────────────────────────────────────────────
//     const newPlayer = await prisma.user.create({
//       data: {
//         username: username.trim(),
//         password: hashedPassword,
//         email: email.trim(),
//         name: name.trim(),
//         phone: phone?.trim() || null,
//         tier: resolvedTier,
//         role: 'PLAYER',
//         status: 'ACTIVE',
//         cashoutLimit: TIER_CASHOUT[resolvedTier] ?? 250,
//         facebook: facebook || null,
//         telegram: telegram || null,
//         instagram: instagram || null,
//         twitterX: x || null,
//         snapchat: snapchat || null,
//         source: sourceList.length ? sourceList.join(', ') : null,
//       },
//     });

//     // ── 2. Link referrer ─────────────────────────────────────────────────────
//     let linkedReferrer = null;

//     if (referralList.length) {
//       // referralList items can be player IDs (number strings) OR usernames/names
//       const idNumbers = referralList.map(v => parseInt(v, 10)).filter(n => !isNaN(n));
//       const nameOrUsernames = referralList.filter(v => isNaN(parseInt(v, 10)));

//       const refUsers = await prisma.user.findMany({
//         where: {
//           OR: [
//             ...(idNumbers.length ? [{ id: { in: idNumbers } }] : []),
//             ...(nameOrUsernames.length ? [{ username: { in: nameOrUsernames } }] : []),
//             ...(nameOrUsernames.length ? [{ name: { in: nameOrUsernames } }] : []),
//           ],
//         },
//         select: { id: true, name: true, username: true },
//       });

//       if (refUsers.length) {
//         linkedReferrer = refUsers[0];
//         await prisma.user.update({
//           where: { id: newPlayer.id },
//           data: { referredBy: linkedReferrer.id },
//         });
//         console.log(`  ✓ Referrer linked: ${linkedReferrer.name} (ID ${linkedReferrer.id})`);
//       }
//     }

//     // ── 3. Link friends ──────────────────────────────────────────────────────
//     if (friendList.length) {
//       const idNumbers = friendList.map(v => parseInt(v, 10)).filter(n => !isNaN(n));
//       const nameOrUsernames = friendList.filter(v => isNaN(parseInt(v, 10)));

//       const friendUsers = await prisma.user.findMany({
//         where: {
//           OR: [
//             ...(idNumbers.length ? [{ id: { in: idNumbers } }] : []),
//             ...(nameOrUsernames.length ? [{ username: { in: nameOrUsernames } }] : []),
//             ...(nameOrUsernames.length ? [{ name: { in: nameOrUsernames } }] : []),
//           ],
//         },
//         select: { id: true, username: true },
//       });

//       if (friendUsers.length) {
//         await prisma.user.update({
//           where: { id: newPlayer.id },
//           data: { friends: { connect: friendUsers.map(f => ({ id: f.id })) } },
//         });
//         console.log(`  ✓ Friends linked: ${friendUsers.map(f => f.username).join(', ')}`);
//       }
//     }

//     // ── 4. Referrer match-bonus (if initialDeposit provided) ─────────────────
//     let bonusInfo = null;

//     if (linkedReferrer && initialDeposit && parseFloat(initialDeposit) > 0) {
//       const depositAmt = parseFloat(initialDeposit);
//       const bonusAmt = parseFloat((depositAmt / 2).toFixed(2));  // 50% match
//       const now = new Date();

//       // Fetch game if gameId supplied (optional)
//       let game = null;
//       if (gameId) {
//         game = await prisma.game.findUnique({ where: { id: gameId } });
//         if (game && game.pointStock < bonusAmt) {
//           // Not enough stock — skip deduction but still record the bonus
//           game = null;
//           console.warn(`  ⚠ Game stock insufficient for referral bonus deduction`);
//         }
//       }

//       const bonusOps = [
//         // Credit referrer balance
//         prisma.user.update({
//           where: { id: linkedReferrer.id },
//           data: { balance: { increment: bonusAmt } },
//         }),
//         // Create Bonus record for referrer
//         prisma.bonus.create({
//           data: {
//             userId: linkedReferrer.id,
//             type: 'REFERRAL',
//             amount: bonusAmt,
//             description: `Referral Match Bonus — ${newPlayer.name} joined with $${depositAmt.toFixed(2)} initial deposit`,
//             claimed: true,
//             claimedAt: now,
//           },
//         }),
//         // Create REFERRAL Transaction for referrer
//         prisma.transaction.create({
//           data: {
//             userId: linkedReferrer.id,
//             type: 'REFERRAL',
//             amount: bonusAmt,
//             status: 'COMPLETED',
//             description: `Referral Match Bonus — ${newPlayer.name} initial deposit $${depositAmt.toFixed(2)}`,
//             notes: `New player: ${newPlayer.name} (ID: ${newPlayer.id})`,
//           },
//         }),
//       ];

//       // Optionally deduct game stock
//       if (game) {
//         const newStock = game.pointStock - bonusAmt;
//         bonusOps.push(
//           prisma.game.update({
//             where: { id: game.id },
//             data: {
//               pointStock: newStock,
//               status: newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY',
//             },
//           })
//         );
//       }

//       await prisma.$transaction(bonusOps);
//       console.log(`  ✓ Referral match bonus $${bonusAmt} credited to ${linkedReferrer.name}`);

//       bonusInfo = {
//         referrerId: linkedReferrer.id,
//         referrerName: linkedReferrer.name,
//         bonusAmount: bonusAmt,
//         gameUsed: game?.name || null,
//       };
//     }

//     res.status(201).json({
//       data: { ...newPlayer, password: undefined },
//       message: 'Player created successfully',
//       referrerBonus: bonusInfo,   // included so the UI can show a confirmation toast
//     });

//   } catch (err) {
//     console.error('Create player error:', err);
//     res.status(500).json({ error: 'Failed to create player' });
//   }
// });


// ══════════════════════════════════════════════════════════════
// ✅ FIXED: POST /api/create-new-player
//
// Key changes vs. original:
//  1. After creating the player, re-fetches with relations included
//     so the response contains fully populated friends + referrer data
//     (the original returned raw Prisma row which has no nested objects).
//  2. The friend-connect now also connects FROM the friend's side
//     so A.friends includes B AND B.friendOf includes A — both are
//     already covered by Prisma's implicit many-to-many, but we add
//     an explicit bidirectional connect to be safe.
//  3. Returns `referredBy` object (not just the raw integer) so the
//     UI can immediately show "Referred by: John" without a reload.
// ══════════════════════════════════════════════════════════════

app.post('/api/create-new-player', authMiddleware, async (req, res) => {
  try {
    const {
      username, password, email, name, phone, tier,
      facebook, telegram, instagram, x, snapchat,
      referrals,      // "who referred this player" — name/username/id of existing player
      friends,        // friend names/usernames/ids
      sources,
      initialDeposit,
      gameId,
    } = req.body;

    if (!username || !password || !email || !name) {
      return res.status(400).json({ error: 'Name, username, password, and email are required' });
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existing) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const resolvedTier = tier || 'BRONZE';

    const toArray = (val) => {
      if (Array.isArray(val)) return val.filter(Boolean);
      if (typeof val === 'string' && val.trim()) return val.split(',').map(s => s.trim()).filter(Boolean);
      return [];
    };

    const referralList = toArray(referrals);   // "referred by" players
    const friendList = toArray(friends);
    const sourceList = toArray(sources);

    // ── 1. Create the player ─────────────────────────────────────────────
    const newPlayer = await prisma.user.create({
      data: {
        username: username.trim(),
        password: hashedPassword,
        email: email.trim(),
        name: name.trim(),
        phone: phone?.trim() || null,
        tier: resolvedTier,
        role: 'PLAYER',
        status: 'ACTIVE',
        cashoutLimit: TIER_CASHOUT[resolvedTier] ?? 250,
        facebook: facebook || null,
        telegram: telegram || null,
        instagram: instagram || null,
        twitterX: x || null,
        snapchat: snapchat || null,
        source: sourceList.length ? sourceList.join(', ') : null,
      },
    });

    // ── Helper: resolve player IDs from a mixed array of IDs / names ─────
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

    // ── 2. Link referrer (the person who brought in this new player) ──────
    let linkedReferrer = null;

    if (referralList.length) {
      const refUsers = await resolveUsers(referralList);
      if (refUsers.length) {
        linkedReferrer = refUsers[0];
        await prisma.user.update({
          where: { id: newPlayer.id },
          data: { referredBy: linkedReferrer.id },
        });
        console.log(`  ✓ Referrer linked: ${linkedReferrer.name} (ID ${linkedReferrer.id})`);
      }
    }

    // ── 3. Link friends (bidirectional) ───────────────────────────────────
    // Prisma's implicit M-M handles the reverse side automatically, but we
    // connect from BOTH sides so the join table always has an entry either way.
    if (friendList.length) {
      const friendUsers = await resolveUsers(friendList);
      if (friendUsers.length) {
        const friendIds = friendUsers.map(f => ({ id: f.id }));

        // Connect new player → friends
        await prisma.user.update({
          where: { id: newPlayer.id },
          data: { friends: { connect: friendIds } },
        });

        // Also connect each friend → new player (ensures both directions)
        await Promise.all(
          friendIds.map(fid =>
            prisma.user.update({
              where: { id: fid.id },
              data: { friends: { connect: [{ id: newPlayer.id }] } },
            })
          )
        );

        console.log(`  ✓ Friends linked: ${friendUsers.map(f => f.username).join(', ')}`);
      }
    }

    // ── 4. Referrer match-bonus on initial deposit ────────────────────────
    let bonusInfo = null;

    if (linkedReferrer && initialDeposit && parseFloat(initialDeposit) > 0) {
      const depositAmt = parseFloat(initialDeposit);
      const bonusAmt = parseFloat((depositAmt / 2).toFixed(2));
      const now = new Date();

      let game = null;
      if (gameId) {
        game = await prisma.game.findUnique({ where: { id: gameId } });
        if (game && game.pointStock < bonusAmt) {
          game = null;
          console.warn('  ⚠ Game stock insufficient for referral bonus deduction');
        }
      }

      const bonusOps = [
        prisma.user.update({ where: { id: linkedReferrer.id }, data: { balance: { increment: bonusAmt } } }),
        prisma.bonus.create({
          data: {
            userId: linkedReferrer.id,
            type: 'REFERRAL',
            amount: bonusAmt,
            description: `Referral Match Bonus — ${newPlayer.name} joined with $${depositAmt.toFixed(2)} initial deposit`,
            claimed: true,
            claimedAt: now,
          },
        }),
        prisma.transaction.create({
          data: {
            userId: linkedReferrer.id,
            type: 'REFERRAL',
            amount: bonusAmt,
            status: 'COMPLETED',
            description: `Referral Match Bonus — ${newPlayer.name} initial deposit $${depositAmt.toFixed(2)}`,
            notes: `New player: ${newPlayer.name} (ID: ${newPlayer.id})`,
          },
        }),
      ];

      if (game) {
        const newStock = game.pointStock - bonusAmt;
        bonusOps.push(
          prisma.game.update({
            where: { id: game.id },
            data: {
              pointStock: newStock,
              status: newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY',
            },
          })
        );
      }

      await prisma.$transaction(bonusOps);
      console.log(`  ✓ Referral match bonus $${bonusAmt} credited to ${linkedReferrer.name}`);
      bonusInfo = { referrerId: linkedReferrer.id, referrerName: linkedReferrer.name, bonusAmount: bonusAmt, gameUsed: game?.name || null };
    }

    // ── 5. Re-fetch with all relations so UI renders correctly ────────────
    // Without this, the response is a raw row — friends & referrer are missing.
    const fullPlayer = await prisma.user.findUnique({
      where: { id: newPlayer.id },
      include: {
        referrer: { select: { id: true, name: true, username: true } },
        referrals: { select: { id: true, name: true, username: true } },
        friends: { select: { id: true, name: true, username: true } },
        friendOf: { select: { id: true, name: true, username: true } },
      },
    });

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

// ══════════════════════════════════════════════════════════════
// 2.  GET /api/players/:id   (full shaped response)
// ══════════════════════════════════════════════════════════════
app.get('/api/players/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid player ID' });

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 200,
        },
        bonuses: true,
        referrals: { select: { id: true, name: true, username: true } },
        // ✅ NEW: the person who referred THIS player
        referrer: { select: { id: true, name: true, username: true } },
        friends: { select: { id: true, name: true, username: true } },
        friendOf: { select: { id: true, name: true, username: true } },
      },
    });


    if (!user) return res.status(404).json({ error: 'Player not found' });

    // console.log("socials: ", user.socials);

    res.json({ data: shapePlayer(user) });
  } catch (err) {
    console.error('Get player error:', err);
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});


// ══════════════════════════════════════════════════════════════
// 3.  PATCH /api/players/:id   (partial update)
// ══════════════════════════════════════════════════════════════
app.patch('/api/players/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid player ID' });

    const {
      name, email, phone, tier, status, balance,
      cashoutLimit,
      facebook, telegram, instagram, x, snapchat,
      source,
    } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (email !== undefined) updateData.email = email.trim();
    if (phone !== undefined) updateData.phone = phone?.trim() || null;
    if (tier !== undefined) {
      updateData.tier = tier;
      // Auto-adjust cashoutLimit when tier changes (unless caller explicitly sets it)
      if (cashoutLimit === undefined) {
        updateData.cashoutLimit = TIER_CASHOUT[tier] ?? 250;
      }
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

    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
    });

    res.json({
      data: { ...updated, password: undefined },
      message: 'Player updated successfully',
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Email already in use by another player' });
    }
    console.error('Update player error:', err);
    res.status(500).json({ error: 'Failed to update player' });
  }
});


// ══════════════════════════════════════════════════════════════
// 4.  DELETE /api/players/:id   (requires admin password)
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// PATCH 4  ──  DELETE /api/players/:id
// Fix: req.user.id → req.userId  (authMiddleware sets req.userId, not req.user)
// ══════════════════════════════════════════════════════════════════════════

app.delete('/api/players/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid player ID' });

    const { adminPassword } = req.body;
    if (!adminPassword) {
      return res.status(400).json({ error: 'Admin password is required to delete a player' });
    }

    // ✅ FIXED: was req.user.id — authMiddleware sets req.userId
    const actingAdmin = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!actingAdmin) return res.status(403).json({ error: 'Admin not found' });

    const passwordMatch = await bcrypt.compare(adminPassword, actingAdmin.password);
    if (!passwordMatch) {
      return res.status(403).json({ error: 'Incorrect admin password' });
    }

    // ✅ FIXED: was req.user.id
    if (id === req.userId) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    await prisma.user.delete({ where: { id } });
    res.json({ message: 'Player deleted successfully' });
  } catch (err) {
    console.error('Delete player error:', err);
    res.status(500).json({ error: 'Failed to delete player' });
  }
});



app.get('/api/transactions/add', authMiddleware, async (req, res) => {

  const data = "This is query for add transactions page, only accessible by admins";
  res.json({ data });
})
//--=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=


// ═══════════════════════════════════════════════════════════════
// -------------------------- DASHBOARD ENDPOINTS -------------------
// ═══════════════════════════════════════════════════════════════
/**
 * GET /api/dashboard/stats
 * Get dashboard statistics
 */
app.get('/api/dashboard/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [
      totalUsers,
      activeUsers,
      totalTransactions,
      pendingTransactions,
      totalDeposits,
      totalWithdrawals,
      totalPlayers,
      newPlayersWeek,
      // ✅ FIX: was prisma.transaction.count({ where: { status: 'PENDING' } })
      // which counted transactions, not issues
      unresolvedIssues,
      resolvedIssues,
      highPriorityIssues,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'PLAYER' } }),
      prisma.user.count({ where: { role: 'PLAYER', status: 'ACTIVE' } }),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: 'PENDING' } }),
      prisma.transaction.aggregate({
        where: { type: 'DEPOSIT', status: 'COMPLETED' },
        _sum: { amount: true }
      }),
      prisma.transaction.aggregate({
        where: { type: 'WITHDRAWAL', status: 'COMPLETED' },
        _sum: { amount: true }
      }),
      prisma.user.count({ where: { role: 'PLAYER' } }),
      prisma.user.count({
        where: {
          role: 'PLAYER',
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }
      }),
      // ✅ These three are the correct issue queries
      prisma.issue.count({ where: { status: 'UNRESOLVED' } }),
      prisma.issue.count({ where: { status: 'RESOLVED' } }),
      prisma.issue.count({ where: { status: 'UNRESOLVED', priority: 'HIGH' } }),
    ]);

    // Today's deposits and cashouts (unchanged)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [todayDeposits, todayCashouts] = await Promise.all([
      prisma.transaction.aggregate({
        where: { type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: today, lt: tomorrow } },
        _sum: { amount: true }
      }),
      prisma.transaction.aggregate({
        where: { type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: today, lt: tomorrow } },
        _sum: { amount: true }
      })
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
      // ✅ Now contains real issue data
      issues: {
        unresolved: unresolvedIssues,
        resolved: resolvedIssues,
        total: unresolvedIssues + resolvedIssues,
        highPriority: highPriorityIssues,
      }
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

app.get('/api/analytics/top-depositors', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const getTop = async (days) => {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);

      const top = await prisma.transaction.groupBy({
        by: ['userId'],
        where: {
          type: 'DEPOSIT',
          status: 'COMPLETED',
          createdAt: { gte: sinceDate }
        },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 10
      });

      return Promise.all(top.map(async (d) => {
        const user = await prisma.user.findUnique({
          where: { id: d.userId },
          select: { id: true, username: true, name: true }
        });
        return { ...user, totalDeposited: parseFloat(d._sum.amount) };
      }));
    };

    const [period_1day, period_7days, period_30days] = await Promise.all([
      getTop(1),
      getTop(7),
      getTop(30)
    ]);

    console.log('Top Depositors - 1 Day:', period_1day);
    console.log('Top Depositors - 7 Days:', period_7days);
    console.log('Top Depositors - 30 Days:', period_30days);
    res.json({ period_1day, period_7days, period_30days });
  } catch (err) {
    console.error('Error fetching top depositors:', err);
    res.status(500).json({ error: 'Failed to fetch top depositors' });
  }
});


app.get('/api/analytics/top-cashouts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const getTopCashouts = async (days) => {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);

      const top = await prisma.transaction.groupBy({
        by: ['userId'],
        where: {
          type: 'WITHDRAWAL',
          status: 'COMPLETED',
          createdAt: { gte: sinceDate }// gte is greater than or equal to, so it will include transactions from the sinceDate onwards
        },
        _sum: { amount: true }, // This will calculate the total amount withdrawn by each user in the specified period
        orderBy: { _sum: { amount: 'desc' } },
        take: 10
      });

      return Promise.all(top.map(async (d) => {
        const user = await prisma.user.findUnique({
          where: { id: d.userId },
          select: { id: true, username: true, name: true }
        });
        return { ...user, totalCashouts: parseFloat(d._sum.amount) };
      }));


    };

    const [period_1day, period_7days, period_30days] = await Promise.all([
      getTopCashouts(1),
      getTopCashouts(7),
      getTopCashouts(30)
    ]);

    console.log('Top Cashouts - 1 Day:', period_1day);
    console.log('Top Cashouts - 7 Days:', period_7days);
    console.log('Top Cashouts - 30 Days:', period_30days);
    res.json({ period_1day, period_7days, period_30days });
  } catch (err) {
    console.error('Error fetching top cashouts:', err);
    res.status(500).json({ error: 'Failed to fetch top cashouts' });
  }
});

app.get('/api/analytics/top-cashouts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const getTopCashouts = async (days) => {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);

      const top = await prisma.transaction.groupBy({
        by: ['userId'],
        where: {
          type: 'WITHDRAWAL',
          status: 'COMPLETED',
          createdAt: { gte: sinceDate }
        },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 10
      });

      return Promise.all(top.map(async (d) => {
        const user = await prisma.user.findUnique({
          where: { id: d.userId },
          select: { id: true, username: true, name: true }
        });
        return { ...user, totalCashouts: parseFloat(d._sum.amount) };
      }));


    };

    const [period_1day, period_7days, period_30days] = await Promise.all([
      getTopCashouts(1),
      getTopCashouts(7),
      getTopCashouts(30)
    ]);

    console.log('Top Cashouts - 1 Day:', period_1day);
    console.log('Top Cashouts - 7 Days:', period_7days);
    console.log('Top Cashouts - 30 Days:', period_30days);
    res.json({ period_1day, period_7days, period_30days });
  } catch (err) {
    console.error('Error fetching top cashouts:', err);
    res.status(500).json({ error: 'Failed to fetch top cashouts' });
  }
});

/**
    * GET /api/profit/stats
    * Get profit statistics for last 30 days
    */
app.get('/api/profit/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const profitData = await prisma.profitStat.findMany({
      where: {
        date: {
          gte: thirtyDaysAgo,
          lte: today
        }
      },
      orderBy: { date: 'asc' }
    });

    const totalProfit = profitData.reduce(
      (sum, p) => sum + parseFloat(p.profit.toString()),
      0
    );

    const avgProfit = profitData.length > 0
      ? totalProfit / profitData.length
      : 0;

    const maxProfit = profitData.length > 0
      ? Math.max(...profitData.map(p => parseFloat(p.profit.toString())))
      : 0;

    const minProfit = profitData.length > 0
      ? Math.min(...profitData.map(p => parseFloat(p.profit.toString())))
      : 0;

    res.json({
      data: profitData.map(p => ({
        date: p.date.toISOString().split('T')[0],
        profit: parseFloat(p.profit.toString())
      })),
      summary: {
        total: parseFloat(totalProfit.toFixed(2)),
        average: parseFloat(avgProfit.toFixed(2)),
        max: parseFloat(maxProfit.toFixed(2)),
        min: parseFloat(minProfit.toFixed(2)),
        daysCount: profitData.length
      }
    });
  } catch (err) {
    console.error('Get profit stats error:', err);
    res.status(500).json({ error: 'Failed to fetch profit stats' });
  }
});



// ═══════════════════════════════════════════════════════════════
// -------------------------- BONUSES ENDPOINTS -------------------
// ═══════════════════════════════════════════════════════════════
/**
 * GET /api/bonuses
 */
app.get('/api/bonuses', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const bonusTxns = await prisma.transaction.findMany({
      where: { type: 'BONUS' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        user: { select: { id: true, name: true } },
      },
    });

    const ledger = bonusTxns.map(t => {
      const desc = t.description || '';
      const notes = t.notes || '';

      // ── Determine bonus type from description ──────────────────────────
      let bonusType = 'bonus';
      if (desc.startsWith('Streak Bonus')) bonusType = 'streak';
      else if (desc.startsWith('Referral Bonus')) bonusType = 'referral';
      else if (desc.startsWith('Match Bonus')) bonusType = 'match';
      else if (desc.startsWith('Special Bonus')) bonusType = 'special';

      // ── Extract game name from description ────────────────────────────
      // Format: "Streak Bonus from GameName" or "Bonus from GameName — notes"
      const gameMatch = desc.match(/^(?:Streak Bonus|Referral Bonus|Match Bonus|Special Bonus|Bonus) from ([^—\n]+?)(?:\s*—|$)/);
      const gameName = gameMatch ? gameMatch[1].trim() : '—';

      // ── Parse balance snapshots from notes ────────────────────────────
      // Format: "balanceBefore:100.00|balanceAfter:115.00|optional notes"
      const balBeforeMatch = notes.match(/balanceBefore:([\d.]+)/);
      const balAfterMatch = notes.match(/balanceAfter:([\d.]+)/);
      const balanceBefore = balBeforeMatch ? parseFloat(balBeforeMatch[1]) : null;
      const balanceAfter = balAfterMatch ? parseFloat(balAfterMatch[1]) : null;

      return {
        id: t.id,
        playerId: t.userId,
        playerName: t.user?.name || '—',
        bonusType,
        description: desc,
        gameName,
        walletMethod: null,   // bonuses don't use a wallet; included for UI consistency
        amount: parseFloat(t.amount),
        balanceBefore,
        balanceAfter,
        createdAt: t.createdAt,
      };
    });

    res.json({ data: ledger });
  } catch (err) {
    console.error('Get bonuses ledger error:', err);
    res.status(500).json({ error: 'Failed to fetch bonus ledger' });
  }
});

app.post('/api/bonuses', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { playerId, amount, gameId, notes, bonusType } = req.body;

    // ── Basic validation ────────────────────────────────────────────────────
    if (!playerId || !amount || !gameId) {
      return res.status(400).json({ error: 'playerId, amount, and gameId are required' });
    }

    const bonusAmount = parseFloat(amount);
    if (isNaN(bonusAmount) || bonusAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // ── Fetch player (include referredBy for referral bonus) ────────────────
    const player = await prisma.user.findUnique({
      where: { id: parseInt(playerId) },
      select: {
        id: true, name: true, balance: true, status: true,
        currentStreak: true,
        referredBy: true,         // referrer ID
      },
    });
    if (!player) return res.status(404).json({ error: 'Player not found' });

    // ── Fetch game ──────────────────────────────────────────────────────────
    const game = await prisma.game.findUnique({ where: { id: gameId } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    // ── Determine bonus label from bonusType ────────────────────────────────
    const isStreak = bonusType === 'streak';
    const isReferral = bonusType === 'referral';
    const bonusLabel = isStreak ? 'Streak Bonus' : isReferral ? 'Referral Bonus' : 'Bonus';

    // ── Referral: also grant to referrer, so game deducts 2× ────────────────
    let referrer = null;
    if (isReferral && player.referredBy) {
      referrer = await prisma.user.findUnique({
        where: { id: player.referredBy },
        select: { id: true, name: true, balance: true },
      });
    }

    // Total game stock deduction
    const totalGameDeduction = (referrer ? 2 : 1) * bonusAmount;

    if (game.pointStock < totalGameDeduction) {
      return res.status(400).json({
        error: `Insufficient game stock. ${game.name} has ${game.pointStock.toFixed(2)} pts, need ${totalGameDeduction.toFixed(2)} pts`
          + (referrer ? ` (×2 for both player and referrer)` : ''),
      });
    }

    // ── Build description texts ─────────────────────────────────────────────
    const playerDesc = notes?.trim()
      ? `${bonusLabel} from ${game.name} — ${notes.trim()}`
      : `${bonusLabel} from ${game.name}`;

    const referrerDesc = `Referral Bonus from ${game.name} — ${player.name}'s deposit`;

    // ── New game stock ──────────────────────────────────────────────────────
    const newStock = game.pointStock - totalGameDeduction;
    const newGameStatus = newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY';

    // ── Balance snapshots for ledger ────────────────────────────────────────
    const playerBalanceBefore = parseFloat(player.balance);
    const playerBalanceAfter = playerBalanceBefore + bonusAmount;

    // ── Build atomic ops ────────────────────────────────────────────────────
    const ops = [];

    // 1. Deduct game stock
    ops.push(
      prisma.game.update({
        where: { id: gameId },
        data: { pointStock: newStock, status: newGameStatus },
      })
    );

    // 2. Credit player balance
    ops.push(
      prisma.user.update({
        where: { id: parseInt(playerId) },
        data: { balance: { increment: bonusAmount } },
      })
    );

    // 3. Bonus record for player
    ops.push(
      prisma.bonus.create({
        data: {
          userId: parseInt(playerId),
          type: isReferral ? 'REFERRAL' : 'CUSTOM',
          amount: bonusAmount,
          description: playerDesc,
          claimed: false,
        },
      })
    );

    // 4. BONUS transaction for player (with balance snapshot in notes)
    ops.push(
      prisma.transaction.create({
        data: {
          userId: parseInt(playerId),
          type: 'BONUS',
          amount: bonusAmount,
          status: 'COMPLETED',
          description: playerDesc,
          paymentMethod: null,
          notes: `balanceBefore:${playerBalanceBefore}|balanceAfter:${playerBalanceAfter}|${notes?.trim() || ''}`,
        },
      })
    );

    // 5. Streak reset (if streak bonus)
    if (isStreak) {
      ops.push(
        prisma.user.update({
          where: { id: parseInt(playerId) },
          data: { currentStreak: 0, lastPlayedDate: null },
        })
      );
    }

    // 6. Referrer bonus (if referral and referrer found)
    let referrerBalanceBefore = null;
    let referrerBalanceAfter = null;
    if (referrer) {
      referrerBalanceBefore = parseFloat(referrer.balance);
      referrerBalanceAfter = referrerBalanceBefore + bonusAmount;

      ops.push(
        prisma.user.update({
          where: { id: referrer.id },
          data: { balance: { increment: bonusAmount } },
        })
      );
      ops.push(
        prisma.bonus.create({
          data: {
            userId: referrer.id,
            type: 'REFERRAL',
            amount: bonusAmount,
            description: referrerDesc,
            claimed: false,
          },
        })
      );
      ops.push(
        prisma.transaction.create({
          data: {
            userId: referrer.id,
            type: 'BONUS',
            amount: bonusAmount,
            status: 'COMPLETED',
            description: referrerDesc,
            paymentMethod: null,
            notes: `balanceBefore:${referrerBalanceBefore}|balanceAfter:${referrerBalanceAfter}`,
          },
        })
      );
    }

    // ── Execute ─────────────────────────────────────────────────────────────
    const results = await prisma.$transaction(ops);
    const updatedGame = results[0];
    const updatedPlayer = results[1];

    res.status(201).json({
      success: true,
      message: [
        `$${bonusAmount.toFixed(2)} ${bonusLabel} granted to ${player.name}.`,
        isStreak ? `Streak reset to 0.` : '',
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
    console.error('Grant bonus error:', err);
    res.status(500).json({ error: 'Failed to grant bonus: ' + err.message });
  }
});



// ═══════════════════════════════════════════════════════════════
// -------------------------- TRANSACTIONS ENDPOINTS -------------------
// ═══════════════════════════════════════════════════════════════
/**
 * GET /api/transactions
 * Get all transactions with filtering and pagination
 */
app.post('/api/payments', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { amount, walletId, category, date, notes } = req.body;

    if (!amount || !walletId) {
      return res.status(400).json({ error: 'Amount and walletId are required' });
    }

    const wallet = await prisma.wallet.findUnique({ where: { id: parseInt(walletId) } });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    if (wallet.balance < parseFloat(amount)) {
      return res.status(400).json({ error: 'Insufficient wallet balance' });
    }

    // Run both operations atomically
    const [updatedWallet, payment] = await prisma.$transaction([
      // 1. Deduct from wallet
      prisma.wallet.update({
        where: { id: parseInt(walletId) },
        data: { balance: wallet.balance - parseFloat(amount) }
      }),
      // 2. Create a payment expense record
      prisma.expense.create({
        data: {
          details: `Payment (${wallet.method} - ${wallet.name})`,
          category: category?.toUpperCase().replace(' ', '_') || 'POINT_RELOAD',
          amount: 0,                          // no cost amount for payments
          paymentMade: parseFloat(amount),    // this is what was paid
          notes: notes || null,
          gameId: null,
        }
      })
    ]);

    res.status(201).json({
      data: { wallet: updatedWallet, payment },
      message: 'Payment recorded and wallet updated'
    });
  } catch (err) {
    console.error('Payment error:', err);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});
// ═══════════════════════════════════════════════════════════════
// FIXED TRANSACTION ENDPOINTS FOR FRONTEND
// ═══════════════════════════════════════════════════════════════
// Paste these endpoints to REPLACE the existing ones in your server.js

// ── helpers ─────────────────────────────────────────────────────────────────

const sameDay = (a, b) =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate();

const isYesterday = (a, b) => {
  const prev = new Date(b);
  prev.setUTCDate(prev.getUTCDate() - 1);
  return sameDay(a, prev);
};

const computeTier = (weeklyTotal) => {
  if (weeklyTotal >= 2500) return 'GOLD';
  if (weeklyTotal >= 1000) return 'SILVER';
  return null;
};

const gameStatus = (stock) =>
  stock <= 0 ? 'DEFICIT' : stock <= 500 ? 'LOW_STOCK' : 'HEALTHY';

// ══════════════════════════════════════════════════════════════
// ✅ FIXED: POST /api/transactions/deposit
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// ✅ FIXED: POST /api/transactions/deposit
//
// Changes vs. the original:
//  1. Accepts `bonusReferral` flag from the frontend
//  2. If flag is true AND the player has a referrer (player.referredBy),
//     BOTH the player and the referrer receive depositAmt × 50% bonus.
//  3. Game stock is deducted 2× for referral (one portion per recipient).
//  4. Separate BONUS + Transaction records are written for the referrer.
//  5. The referrer's bonus shows up in their own transaction history.
// ══════════════════════════════════════════════════════════════

app.post('/api/transactions/deposit', authMiddleware, async (req, res) => {
  try {
    const {
      playerId,
      amount,
      walletId,
      walletMethod,
      walletName,
      gameId,
      notes,
      bonusMatch = false,
      bonusSpecial = false,
      bonusReferral = false,   // ← NEW: admin checks this to grant referral bonus
    } = req.body;

    // ── Basic validation ──────────────────────────────────────────────────
    if (!playerId || !amount || !walletId) {
      return res.status(400).json({ error: 'playerId, amount and walletId are required' });
    }

    const depositAmt = parseFloat(amount);
    if (isNaN(depositAmt) || depositAmt <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const anyBonus = bonusMatch || bonusSpecial || bonusReferral;
    if (anyBonus && !gameId) {
      return res.status(400).json({ error: 'gameId is required when any bonus is applied' });
    }

    // ── Fetch player (need referredBy to check for referrer) ──────────────
    const player = await prisma.user.findUnique({
      where: { id: parseInt(playerId) },
      select: {
        id: true,
        name: true,
        balance: true,
        tier: true,
        currentStreak: true,
        lastPlayedDate: true,
        referredBy: true,   // FK integer — tells us who referred this player
      },
    });
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const balanceBefore = parseFloat(player.balance);

    // ── Fetch referrer if referral bonus requested ─────────────────────────
    let referrer = null;
    if (bonusReferral && player.referredBy) {
      referrer = await prisma.user.findUnique({
        where: { id: player.referredBy },
        select: { id: true, name: true, balance: true },
      });
      if (!referrer) {
        // Referrer was deleted — skip silently rather than blocking the deposit
        console.warn(`[deposit] referrer ID ${player.referredBy} not found — skipping referral bonus`);
      }
    }

    // ── Fetch wallet ──────────────────────────────────────────────────────
    const wallet = await prisma.wallet.findUnique({
      where: { id: parseInt(walletId) },
      select: { id: true, name: true, method: true, balance: true },
    });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    // ── Fetch game if any bonus applies ───────────────────────────────────
    let game = null;
    if (anyBonus) {
      game = await prisma.game.findUnique({
        where: { id: gameId },
        select: { id: true, name: true, pointStock: true },
      });
      if (!game) return res.status(404).json({ error: 'Game not found' });
    }

    // ── Compute bonus amounts ─────────────────────────────────────────────
    const matchAmt = bonusMatch ? depositAmt * 0.5 : 0;
    const specialAmt = bonusSpecial ? depositAmt * 0.2 : 0;
    const referralAmt = bonusReferral && referrer ? depositAmt * 0.5 : 0;

    // Game stock needed:
    //  • matchAmt    → deduct 1× (player only)
    //  • specialAmt  → deduct 1× (player only)
    //  • referralAmt → deduct 2× (player + referrer each receive it)
    const totalGameDeduction = matchAmt + specialAmt + (referralAmt * (referrer ? 2 : 1));

    if (game && totalGameDeduction > game.pointStock) {
      return res.status(400).json({
        error: `Insufficient game stock. ${game.name} has ${game.pointStock.toFixed(2)} pts, need ${totalGameDeduction.toFixed(2)} pts`,
      });
    }

    // ── Streak update ─────────────────────────────────────────────────────
    const now = new Date();
    const lastPlayed = player.lastPlayedDate ? new Date(player.lastPlayedDate) : null;
    let newStreak = player.currentStreak || 0;

    if (!lastPlayed) {
      newStreak = 1;
    } else if (!sameDay(lastPlayed, now)) {
      newStreak = isYesterday(lastPlayed, now) ? newStreak + 1 : 1;
    }

    // ── Build atomic operations ───────────────────────────────────────────
    const ops = [];

    const totalPlayerCredit = depositAmt + matchAmt + specialAmt + referralAmt;
    const balanceAfter = balanceBefore + totalPlayerCredit;

    // 1. Update player balance + streak
    ops.push(
      prisma.user.update({
        where: { id: parseInt(playerId) },
        data: { balance: balanceAfter, currentStreak: newStreak, lastPlayedDate: now },
      })
    );

    // 2. Add to wallet balance (deposit flows IN)
    ops.push(
      prisma.wallet.update({
        where: { id: parseInt(walletId) },
        data: { balance: { increment: depositAmt } },
      })
    );

    // 3. DEPOSIT transaction for player
    ops.push(
      prisma.transaction.create({
        data: {
          userId: parseInt(playerId),
          type: 'DEPOSIT',
          amount: new Prisma.Decimal(depositAmt.toString()),
          status: 'COMPLETED',
          description: `Deposit via ${walletMethod || wallet.method} - ${walletName || wallet.name}`,
          notes: notes || null,
          gameId: game?.id || null,
          paymentMethod: null,
        },
      })
    );

    // 4. Game stock deduction
    if (game && totalGameDeduction > 0) {
      const newStock = game.pointStock - totalGameDeduction;
      const newStatus = newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY';
      ops.push(
        prisma.game.update({
          where: { id: gameId },
          data: { pointStock: newStock, status: newStatus },
        })
      );
    }

    // ── 5. Match bonus (player only) ──────────────────────────────────────
    if (bonusMatch) {
      ops.push(
        prisma.bonus.create({
          data: {
            userId: parseInt(playerId),
            type: 'DEPOSIT_MATCH',
            amount: new Prisma.Decimal(matchAmt.toString()),
            description: `Match Bonus - 50% of $${depositAmt.toFixed(2)}`,
            claimed: true,
            claimedAt: now,
          },
        })
      );
      ops.push(
        prisma.transaction.create({
          data: {
            userId: parseInt(playerId),
            type: 'BONUS',
            amount: new Prisma.Decimal(matchAmt.toString()),
            status: 'COMPLETED',
            description: `Match Bonus from ${game.name} - 50% of $${depositAmt.toFixed(2)}`,
            notes: `gameId:${game.id}|From game: ${game.name}|balanceBefore:${balanceBefore}|balanceAfter:${balanceAfter}`,
          },
        })
      );
    }

    // ── 6. Special bonus (player only) ───────────────────────────────────
    if (bonusSpecial) {
      ops.push(
        prisma.bonus.create({
          data: {
            userId: parseInt(playerId),
            type: 'CUSTOM',
            amount: new Prisma.Decimal(specialAmt.toString()),
            description: `Special Bonus - 20% of $${depositAmt.toFixed(2)}`,
            claimed: true,
            claimedAt: now,
          },
        })
      );
      ops.push(
        prisma.transaction.create({
          data: {
            userId: parseInt(playerId),
            type: 'BONUS',
            amount: new Prisma.Decimal(specialAmt.toString()),
            status: 'COMPLETED',
            description: `Special Bonus from ${game.name} - 20% of $${depositAmt.toFixed(2)}`,
            notes: `gameId:${game.id}|From game: ${game.name}|balanceBefore:${balanceBefore}|balanceAfter:${balanceAfter}`,
          },
        })
      );
    }

    // ── 7. Referral bonus — player side ───────────────────────────────────
    if (referralAmt > 0 && referrer) {
      const playerBalBeforeRef = balanceBefore + matchAmt + specialAmt; // balance just before referral credit
      const playerBalAfterRef = playerBalBeforeRef + referralAmt;

      ops.push(
        prisma.bonus.create({
          data: {
            userId: parseInt(playerId),
            type: 'REFERRAL',
            amount: new Prisma.Decimal(referralAmt.toString()),
            description: `Referral Bonus from ${game.name} — referred by ${referrer.name}`,
            claimed: true,
            claimedAt: now,
          },
        })
      );
      ops.push(
        prisma.transaction.create({
          data: {
            userId: parseInt(playerId),
            type: 'BONUS',
            amount: new Prisma.Decimal(referralAmt.toString()),
            status: 'COMPLETED',
            description: `Referral Bonus from ${game.name} — referred by ${referrer.name}`,
            notes: `gameId:${game.id}|From game: ${game.name}|balanceBefore:${playerBalBeforeRef.toFixed(2)}|balanceAfter:${playerBalAfterRef.toFixed(2)}`,
          },
        })
      );

      // ── 8. Referral bonus — REFERRER side ─────────────────────────────
      const referrerBalBefore = parseFloat(referrer.balance);
      const referrerBalAfter = referrerBalBefore + referralAmt;

      // Credit referrer balance
      ops.push(
        prisma.user.update({
          where: { id: referrer.id },
          data: { balance: { increment: referralAmt } },
        })
      );
      // Referrer Bonus record
      ops.push(
        prisma.bonus.create({
          data: {
            userId: referrer.id,
            type: 'REFERRAL',
            amount: new Prisma.Decimal(referralAmt.toString()),
            description: `Referral Bonus from ${game.name} — ${player.name}'s $${depositAmt.toFixed(2)} deposit`,
            claimed: true,
            claimedAt: now,
          },
        })
      );
      // Referrer BONUS Transaction (shows in their history)
      ops.push(
        prisma.transaction.create({
          data: {
            userId: referrer.id,
            type: 'BONUS',
            amount: new Prisma.Decimal(referralAmt.toString()),
            status: 'COMPLETED',
            description: `Referral Bonus from ${game.name} — ${player.name}'s $${depositAmt.toFixed(2)} deposit`,
            notes: `gameId:${game.id}|From game: ${game.name}|balanceBefore:${referrerBalBefore.toFixed(2)}|balanceAfter:${referrerBalAfter.toFixed(2)}`,
          },
        })
      );
    }

    // ── Execute all ops atomically ────────────────────────────────────────
    const results = await prisma.$transaction(ops);
    const updatedPlayer = results[0];
    const updatedWallet = results[1];
    const depositTx = results[2];

    // ── Build response summary ────────────────────────────────────────────
    const bonusesApplied = [];
    if (bonusMatch) bonusesApplied.push(`Match Bonus +$${matchAmt.toFixed(2)}`);
    if (bonusSpecial) bonusesApplied.push(`Special Bonus +$${specialAmt.toFixed(2)}`);
    if (referralAmt > 0 && referrer) bonusesApplied.push(`Referral Bonus +$${referralAmt.toFixed(2)} to both ${player.name} & ${referrer.name}`);

    res.status(201).json({
      success: true,
      message: [
        `Deposit of $${depositAmt.toFixed(2)} recorded for ${player.name}.`,
        ...bonusesApplied,
        `Wallet ${walletName || wallet.name} updated.`,
      ].join(' '),
      transaction: {
        id: depositTx.id,
        playerId: player.id,
        playerName: player.name,
        type: 'Deposit',
        amount: depositAmt,
        walletId,
        walletMethod: walletMethod || wallet.method,
        walletName: walletName || wallet.name,
        gameName: game?.name || null,
        balanceBefore,
        balanceAfter: parseFloat(updatedPlayer.balance),
        status: 'COMPLETED',
        timestamp: depositTx.createdAt,
        referralBonus: referralAmt > 0 && referrer
          ? { referrerId: referrer.id, referrerName: referrer.name, amount: referralAmt }
          : null,
      },
      data: {
        playerBalance: parseFloat(updatedPlayer.balance),
        walletBalance: parseFloat(updatedWallet.balance),
      },
    });

  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Deposit failed: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ✅ FIXED: POST /api/transactions/cashout
// ══════════════════════════════════════════════════════════════
app.post('/api/transactions/cashout', authMiddleware, async (req, res) => {
  try {
    const {
      playerId,
      amount,
      walletId,
      walletMethod,      // ← NEW: from frontend
      walletName,        // ← NEW: from frontend
      notes,
    } = req.body;

    // Validation
    if (!playerId || !amount || !walletId) {
      return res.status(400).json({ error: 'playerId, amount and walletId are required' });
    }

    const cashoutAmt = parseFloat(amount);
    if (isNaN(cashoutAmt) || cashoutAmt <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // Fetch player
    const player = await prisma.user.findUnique({
      where: { id: parseInt(playerId) },
      select: {
        id: true,
        name: true,
        balance: true,
        currentStreak: true,
      },
    });
    if (!player) return res.status(404).json({ error: 'Player not found' });

    // Store ORIGINAL balance for before/after
    const balanceBefore = parseFloat(player.balance);

    // Validate balance
    if (cashoutAmt > balanceBefore) {
      return res.status(400).json({
        error: `Insufficient player balance. Has $${balanceBefore.toFixed(2)}, requested $${cashoutAmt.toFixed(2)}.`,
      });
    }

    // Fetch wallet
    const wallet = await prisma.wallet.findUnique({
      where: { id: parseInt(walletId) },
      select: { id: true, name: true, method: true, balance: true }
    });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    // Validate wallet balance
    if (cashoutAmt > wallet.balance) {
      return res.status(400).json({
        error: `Insufficient wallet balance. Has $${wallet.balance.toFixed(2)}, requested $${cashoutAmt.toFixed(2)}.`,
      });
    }

    // Calculate new balance AFTER cashout
    const balanceAfter = balanceBefore - cashoutAmt;

    // Execute atomically
    const [updatedPlayer, updatedWallet, tx] = await prisma.$transaction([
      prisma.user.update({
        where: { id: parseInt(playerId) },
        data: { balance: balanceAfter },
      }),
      prisma.wallet.update({
        where: { id: parseInt(walletId) },
        data: { balance: { decrement: cashoutAmt } },
      }),
      prisma.transaction.create({
        data: {
          userId: parseInt(playerId),
          type: 'WITHDRAWAL',
          amount: new Prisma.Decimal(cashoutAmt.toString()),
          status: 'COMPLETED',
          description: `Cashout via ${walletMethod || wallet.method} - ${walletName || wallet.name}`,
          notes: notes || null,
          paymentMethod: null,
        },
      }),
    ]);

    res.status(201).json({
      success: true,
      message: `Cashout of $${cashoutAmt.toFixed(2)} recorded for ${player.name}.`,
      transaction: {
        id: tx.id,
        playerId: player.id,
        playerName: player.name,
        type: 'Cashout',
        amount: cashoutAmt,
        walletId: walletId,
        walletMethod: walletMethod || wallet.method,
        walletName: walletName || wallet.name,
        gameName: null,
        balanceBefore: balanceBefore,
        balanceAfter: parseFloat(updatedPlayer.balance),
        status: 'COMPLETED',
        timestamp: tx.createdAt,
      },
      data: {
        playerBalance: parseFloat(updatedPlayer.balance),
        walletBalance: parseFloat(updatedWallet.balance),
      },
    });

  } catch (err) {
    console.error('Cashout error:', err);
    res.status(500).json({ error: 'Cashout failed: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ✅ FIXED: GET /api/transactions
// ══════════════════════════════════════════════════════════════
app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 10, type = '', status = '' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let where = {};
    if (type) where.type = type;
    if (status) where.status = status;

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            }
          }
        },
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
      }),
      prisma.transaction.count({ where })
    ]);

    // ✅ FIXED: Properly format transactions with ALL required fields
    const formatted = transactions.map(t => {
      // Determine transaction type display
      let type = t.type;
      let bonusType = null;

      if (t.type === 'DEPOSIT') type = 'Deposit';
      else if (t.type === 'WITHDRAWAL') type = 'Cashout';
      else if (t.type === 'BONUS') {
        // Parse bonus type from description
        if (t.description?.includes('Match')) {
          type = 'Match Bonus';
          bonusType = 'match';
        } else if (t.description?.includes('Special')) {
          type = 'Special Bonus';
          bonusType = 'special';
        } else if (t.description?.includes('Streak')) {
          type = 'Streak Bonus';
          bonusType = 'streak';
        } else if (t.description?.includes('Referral')) {
          type = 'Referral Bonus';
          bonusType = 'referral';
        } else {
          type = 'Bonus';
        }
      }

      // Extract wallet info from description or payment method
      let walletMethod = t.paymentMethod || 'Unknown';
      let walletName = 'Account';

      // Try to parse from description: "Deposit via PAYPAL - Main Account"
      const match = t.description?.match(/via ([^ ]+) - (.*?)$/);
      if (match) {
        walletMethod = match[1];
        walletName = match[2];
      }

      // // Extract game name from notes
      // const gameMatch = t.notes?.match(/From game: (.*?)$/);

      // const gameName = gameMatch ? gameMatch[1] : null;
      const gameMatch = t.notes?.match(/From game: ([^|]+)(?:\|balanceBefore:([\d.]+)\|balanceAfter:([\d.]+))?/);

      const gameName = gameMatch ? gameMatch[1].trim() : null;
      const balanceBefore = gameMatch?.[2] ? parseFloat(gameMatch[2]) : null;
      const balanceAfter = gameMatch?.[3] ? parseFloat(gameMatch[3]) : null;
      return {
        id: `TXN${String(t.id).padStart(6, '0')}`,
        playerId: t.userId,
        playerName: t.user?.name || '—',
        email: t.user?.email || '—',
        type,
        bonusType,
        amount: parseFloat(t.amount),
        walletMethod,
        walletName,
        gameName,
        // ✅ These will be populated from a separate query or stored in transaction
        balanceBefore,  // Need to fetch separately
        balanceAfter,   // Need to fetch separately
        status: t.status,
        timestamp: fmtTX(t.createdAt),
        date: fmtTXDate(t.createdAt),
      };
    });

    res.json({
      data: formatted,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Get transactions error:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ══════════════════════════════════════════════════════════════
// ✅ FIXED: POST /api/transactions/:transactionId/undo
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// POST /api/transactions/:transactionId/undo
// Replace the existing undo endpoint in server.js with this version.
// Added console.log at every step so you can see exactly what happens.
// ══════════════════════════════════════════════════════════════

app.post('/api/transactions/:transactionId/undo', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const transactionId = parseInt(req.params.transactionId);
    console.log(`\n🔄 UNDO: starting for transaction #${transactionId}`);

    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        user: { select: { id: true, name: true, balance: true } }
      }
    });
    console.log(`\n undo transaction is: #${transaction.notes}`);

    if (!transaction) {
      console.log(`❌ UNDO: transaction #${transactionId} not found`);
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (transaction.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Transaction is already cancelled' });
    }

    console.log(`✓ UNDO: found transaction type=${transaction.type} amount=${transaction.amount} userId=${transaction.userId}, gameID=${transaction.gameId} and game=${transaction.game}`);
    console.log(`  description: "${transaction.description}"`);
    console.log(`  notes: "${transaction.notes}"`);

    // ── Balance reversal ──────────────────────────────────────────
    let balanceAdjustment = 0;
    if (transaction.type === 'DEPOSIT') balanceAdjustment = -parseFloat(transaction.amount);
    else if (transaction.type === 'WITHDRAWAL') balanceAdjustment = parseFloat(transaction.amount);
    else if (transaction.type === 'BONUS') balanceAdjustment = -parseFloat(transaction.amount);

    const playerBalance = parseFloat(transaction.user.balance) + balanceAdjustment;
    console.log(`player balance: ${transaction.user.balance} → ${playerBalance}`);

    // ── Wallet lookup ──────────────────────────────────────────────
    let wallet = null;
    const walletMatch = transaction.description?.match(/via ([^ ]+) - (.+)$/);
    if (walletMatch) {
      wallet = await prisma.wallet.findFirst({
        where: { method: walletMatch[1], name: walletMatch[2] }
      });
      if (wallet) {
        console.log(`  wallet found: ${wallet.method} - ${wallet.name} (id=${wallet.id})`);
      } else {
        console.log(`  ⚠ wallet NOT found for method="${walletMatch[1]}" name="${walletMatch[2]}"`);
      }
    } else {
      console.log(`  ⚠ no wallet pattern in description`);
    }

    const ops = [];

    // 1. Reverse player balance
    ops.push(
      prisma.user.update({
        where: { id: transaction.userId },
        data: { balance: playerBalance }
      })
    );

    // 2. Cancel this transaction
    ops.push(
      prisma.transaction.update({
        where: { id: transactionId },
        data: { status: 'CANCELLED' }
      })
    );

    // 3. Reverse wallet balance
    if (wallet) {
      ops.push(
        prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: transaction.type === 'WITHDRAWAL'
              ? { increment: parseFloat(transaction.amount) }
              : { decrement: parseFloat(transaction.amount) }
          }
        })
      );
    }

    // ── Game restore (DEPOSIT only) ────────────────────────────────
    const gameRestoreMap = {};

    if (transaction.type === 'DEPOSIT' || transaction.type === 'BONUS') {
      console.log(`  searching for BONUS transactions within ±10s...`);

      const bonusTxns = await prisma.transaction.findMany({
        where: {
          userId: transaction.userId,
          type: 'BONUS',
          status: 'COMPLETED',
          createdAt: {
            gte: new Date(transaction.createdAt.getTime() - 10000),
            lte: new Date(transaction.createdAt.getTime() + 10000),
          }
        }
      });

      console.log(`  found ${bonusTxns.length} bonus transaction(s)`);

      for (const bonusTx of bonusTxns) {
        console.log(`  bonus tx #${bonusTx.id}: amount=${bonusTx.amount} notes="${bonusTx.notes}"`);

        // ── Format 1 (current): "gameId:cuid|From game: Name"
        const idMatch = bonusTx.notes?.match(/^gameId:([^|]+)\|/);
        if (idMatch) {
          const gId = idMatch[1].trim();
          gameRestoreMap[gId] = (gameRestoreMap[gId] || 0) + parseFloat(bonusTx.amount);
          console.log(`    → matched new format, gameId="${gId}", restore +${bonusTx.amount}`);
        } else {
          // ── Format 2 (old): "From game: Name"
          const nameMatch = bonusTx.notes?.match(/From game: (.+)$/);
          if (nameMatch) {
            const gameName = nameMatch[1].trim();
            const g = await prisma.game.findFirst({ where: { name: gameName } });
            if (g) {
              gameRestoreMap[g.id] = (gameRestoreMap[g.id] || 0) + parseFloat(bonusTx.amount);
              console.log(`    → matched old format, game="${gameName}" id="${g.id}", restore +${bonusTx.amount}`);
            } else {
              console.log(`    → old format matched but game "${gameName}" NOT found in DB`);
            }
          } else {
            // ── Format 3 (seed data): "Game: Name"
            const seedMatch = bonusTx.notes?.match(/^Game: (.+)$/);
            if (seedMatch) {
              const gameName = seedMatch[1].trim();
              const g = await prisma.game.findFirst({ where: { name: gameName } });
              if (g) {
                gameRestoreMap[g.id] = (gameRestoreMap[g.id] || 0) + parseFloat(bonusTx.amount);
                console.log(`    → matched seed format, game="${gameName}" id="${g.id}", restore +${bonusTx.amount}`);
              } else {
                console.log(`    → seed format matched but game "${gameName}" NOT found in DB`);
              }
            } else {
              console.log(`    → ⚠ notes format unrecognised, cannot map to game`);
            }
          }
        }

        // Cancel bonus transaction regardless
        ops.push(
          prisma.transaction.update({
            where: { id: bonusTx.id },
            data: { status: 'CANCELLED' }
          })
        );
      }

      console.log(`  gameRestoreMap:`, gameRestoreMap);

      // Build game update ops
      for (const [gameId, restoreAmount] of Object.entries(gameRestoreMap)) {
        const game = await prisma.game.findUnique({ where: { id: gameId } });


        if (game) {
          const newStock = parseFloat(game.pointStock) + restoreAmount;
          const newStatus = newStock <= 0 ? 'DEFICIT' : newStock <= 500 ? 'LOW_STOCK' : 'HEALTHY';
          console.log(`  game "${game.name}" (${gameId}): ${game.pointStock} → ${newStock} (${newStatus})`);
          ops.push(
            prisma.game.update({
              where: { id: game.id },
              data: { pointStock: newStock, status: newStatus }
            })
          );
        } else {
          console.log(`  ⚠ game with id "${gameId}" NOT found in DB`);
        }
      }
    }

    console.log(`  executing ${ops.length} DB operations...`);
    await prisma.$transaction(ops);
    console.log(`✅ UNDO #${transactionId}: complete\n`);

    res.json({
      success: true,
      message: `Transaction #${transactionId} reversed successfully`,
      updatedBalances: {
        playerBalance,
        walletBalance: wallet
          ? parseFloat(wallet.balance) + (transaction.type === 'WITHDRAWAL'
            ? parseFloat(transaction.amount)
            : -parseFloat(transaction.amount))
          : null,
      },
      gamePointsRestored: Object.keys(gameRestoreMap).length > 0 ? gameRestoreMap : null,
    });

  } catch (err) {
    console.error('❌ Undo transaction error:', err);
    res.status(500).json({ error: 'Failed to undo transaction: ' + err.message });
  }
});


// ═══════════════════════════════════════════════════════════════
// -------------------------- GAMES ENDPOINTS -------------------
// ═══════════════════════════════════════════════════════════════
app.get('/api/games', authMiddleware, async (req, res) => {
  try {
    const { status, search } = req.query;

    const where = {};
    if (status) where.status = status.toUpperCase();          // 'LOW_STOCK', 'DEFICIT', 'HEALTHY'
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const games = await prisma.game.findMany({
      where,
      orderBy: { name: 'asc' }
    });

    res.json({ data: games });
  } catch (err) {
    console.error('Get games error:', err);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});
/**
 * POST /api/games
 * Create a new game
 */
app.post('/api/games', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, slug, pointStock, status } = req.body;

    // Validation
    if (!name || !slug) {
      return res.status(400).json({ error: 'Name and slug are required' });
    }

    const validStatuses = ['HEALTHY', 'LOW_STOCK', 'DEFICIT'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status must be HEALTHY, LOW_STOCK, or DEFICIT' });
    }

    // Check for duplicates
    const existing = await prisma.game.findFirst({
      where: { OR: [{ name }, { slug }] }
    });
    if (existing) {
      return res.status(409).json({ error: 'A game with that name or slug already exists' });
    }

    const game = await prisma.game.create({
      data: {
        name: name.trim(),
        slug: slug.trim(),
        pointStock: pointStock ?? 0,
        status: status ?? 'HEALTHY',
      }
    });

    res.status(201).json({
      data: game,
      message: 'Game created successfully'
    });
  } catch (err) {
    console.error('Create game error:', err);
    res.status(500).json({ error: 'Failed to create game' });
  }
});

// ----------update games points -------------
app.patch('/api/games/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    // console.log(id);
    const { pointStock, status } = req.body;
    // console.log(pointStock)
    const game = await prisma.game.findUnique({ where: { id } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const updatedGame = await prisma.game.update({
      where: { id },
      data: {
        ...(pointStock !== undefined && { pointStock }),
        ...(status && { status }),
      }
    });

    res.json({ data: updatedGame, message: 'Game updated successfully' });
  } catch (err) {
    console.error('Update game error:', err);
    res.status(500).json({ error: 'Failed to update game' });
  }
});

app.delete('/api/games/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { adminPassword } = req.body;

    // ── 1. Require admin password ─────────────────────────────────────────
    if (!adminPassword) {
      return res.status(400).json({ error: 'Admin password is required to delete a game' });
    }

    // ── 2. Verify the password of the acting admin ────────────────────────
    const actingAdmin = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!actingAdmin) return res.status(403).json({ error: 'Admin not found' });

    const passwordMatch = await bcrypt.compare(adminPassword, actingAdmin.password);
    if (!passwordMatch) {
      return res.status(403).json({ error: 'Incorrect admin password' });
    }

    // ── 3. Confirm the game exists ────────────────────────────────────────
    const game = await prisma.game.findUnique({ where: { id } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    // ── 4. Delete the game ────────────────────────────────────────────────
    await prisma.game.delete({ where: { id } });

    res.json({ message: `Game "${game.name}" deleted successfully` });
  } catch (err) {
    console.error('Delete game error:', err);
    res.status(500).json({ error: 'Failed to delete game' });
  }
});
// ═══════════════════════════════════════════════════════════════
// -------------------------- EXPENSES ENDPOINTS -------------------
// ═══════════════════════════════════════════════════════════════
// GET /api/expenses — fetch all expenses
app.get('/api/expenses', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { category, search } = req.query;

    const where = {};
    if (category) where.category = category.toUpperCase().replace(' ', '_');
    if (search) where.details = { contains: search, mode: 'insensitive' };

    const expenses = await prisma.expense.findMany({
      where,
      include: { game: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ data: expenses });
  } catch (err) {
    console.error('Get expenses error:', err);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// POST /api/expenses — create a new expense
app.post('/api/expenses', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { gameId, details, category, amount, pointsAdded, notes } = req.body;

    if (!details || !amount) {
      return res.status(400).json({ error: 'Details and amount are required' });
    }

    const expense = await prisma.expense.create({
      data: {
        gameId: gameId || null,
        details,
        category: category?.toUpperCase().replace(' ', '_') || 'POINT_RELOAD',
        amount: parseFloat(amount),
        pointsAdded: pointsAdded || 0,
        notes: notes || null,
      },
      include: { game: { select: { id: true, name: true } } }
    });

    res.status(201).json({ data: expense, message: 'Expense recorded successfully' });
  } catch (err) {
    console.error('Create expense error:', err);
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

app.patch('/api/expenses/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, category, notes, pointsAdded, paymentMade, walletId } = req.body;

    const expense = await prisma.expense.findUnique({ where: { id } });
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    // ── Payment edit: adjust wallet balance by the difference ──────────────
    if (paymentMade !== undefined && walletId) {
      const oldAmount = parseFloat(expense.paymentMade || 0);
      const newAmount = parseFloat(paymentMade);
      const diff = newAmount - oldAmount; // positive = paying more, negative = paying less

      const wallet = await prisma.wallet.findUnique({ where: { id: parseInt(walletId) } });
      if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

      // Only block if trying to pay MORE than what the wallet has
      if (diff > 0 && wallet.balance < diff) {
        return res.status(400).json({ error: `Insufficient wallet balance. Available: $${wallet.balance.toFixed(2)}` });
      }

      const [updatedExpense] = await prisma.$transaction([
        prisma.expense.update({
          where: { id },
          data: {
            paymentMade: newAmount,
            ...(notes !== undefined && { notes }),
            ...(category && { category: category.toUpperCase().replace(' ', '_') }),
          }
        }),
        prisma.wallet.update({
          where: { id: parseInt(walletId) },
          data: { balance: { decrement: diff } } // decrement by diff: positive = deduct more, negative = add back
        }),
      ]);

      return res.json({ data: updatedExpense, message: 'Payment updated and wallet adjusted' });
    }

    // ── Regular expense edit ───────────────────────────────────────────────
    const updated = await prisma.expense.update({
      where: { id },
      data: {
        ...(amount !== undefined && { amount: parseFloat(amount) }),
        ...(category && { category: category.toUpperCase().replace(' ', '_') }),
        ...(notes !== undefined && { notes }),
        ...(pointsAdded !== undefined && { pointsAdded: parseInt(pointsAdded, 10) }),
      }
    });

    res.json({ data: updated, message: 'Expense updated' });
  } catch (err) {
    console.error('Update expense error:', err);
    res.status(500).json({ error: 'Failed to update expense' });
  }
});


// ═══════════════════════════════════════════════════════════════
// -------------------------- WALLETS ENDPOINTS -------------------
// ═══════════════════════════════════════════════════════════════
// // GET /api/wallets — fetch all wallets grouped by method
app.get('/api/wallets', authMiddleware, async (req, res) => {
  try {
    const wallets = await prisma.wallet.findMany({
      orderBy: [{ method: 'asc' }, { name: 'asc' }]
    });

    // Group wallets by payment method
    const grouped = wallets.reduce((acc, wallet) => {
      if (!acc[wallet.method]) {
        acc[wallet.method] = {
          method: wallet.method,
          totalBalance: 0,
          subAccounts: []
        };
      }
      acc[wallet.method].subAccounts.push(wallet);
      acc[wallet.method].totalBalance += wallet.balance || 0;
      return acc;
    }, {});

    res.json({ data: Object.values(grouped) });
  } catch (err) {
    console.error('Get wallets error:', err);
    res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

// PATCH /api/wallets/:id — update wallet balance
app.patch('/api/wallets/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { balance, name, identifier } = req.body;

    const wallet = await prisma.wallet.findUnique({ where: { id: parseInt(id) } });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const updated = await prisma.wallet.update({
      where: { id: parseInt(id) },
      data: {
        ...(balance !== undefined && { balance: parseFloat(balance) }),
        ...(name && { name }),
        ...(identifier !== undefined && { identifier }),
      }
    });

    res.json({ data: updated, message: 'Wallet updated' });
  } catch (err) {
    console.error('Update wallet error:', err);
    res.status(500).json({ error: 'Failed to update wallet' });
  }
});

// POST /api/wallets — create wallet
app.post('/api/wallets', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, method, identifier, balance } = req.body;
    if (!name || !method) return res.status(400).json({ error: 'Name and method are required' });

    const wallet = await prisma.wallet.create({
      data: { name, method, identifier: identifier || null, balance: balance || 0 }
    });

    res.status(201).json({ data: wallet, message: 'Wallet created' });
  } catch (err) {
    console.error('Create wallet error:', err);
    res.status(500).json({ error: 'Failed to create wallet' });
  }
});

// DELETE /api/wallets/:id
app.delete('/api/wallets/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await prisma.wallet.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Wallet deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete wallet' });
  }
});


/**
 * GET /api/attendance
 * Get attendance records
 */

app.get('/api/attendance', authMiddleware, async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;

    // Convert to numbers
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    // Build where clause
    let whereClause = {};
    if (status && status !== 'all') {
      // Convert frontend status to database status
      const statusMap = {
        'Active': 'ACTIVE',
        'Critical': 'CRITICAL',
        'Highly-Critical': 'HIGHLY_CRITICAL',
        'Inactive': 'INACTIVE'
      };
      whereClause.status = statusMap[status] || status;
    }

    // Fetch users with pagination
    const users = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        status: true,
        balance: true,
        tier: true,
        lastActivityAt: true,
        createdAt: true
      },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      orderBy: { createdAt: 'desc' }
    });

    // Convert status to display format
    const usersFormatted = users.map(user => ({
      ...user,
      attendanceStatus: user.status === 'ACTIVE' ? 'Active'
        : user.status === 'CRITICAL' ? 'Critical'
          : user.status === 'HIGHLY_CRITICAL' ? 'Highly-Critical'
            : 'Inactive'
    }));

    // Get total count for requested status
    const total = await prisma.user.count({
      where: whereClause
    });

    // Get stats for ALL statuses
    const allUsers = await prisma.user.findMany({
      select: { status: true }
    });

    const stats = {
      active: allUsers.filter(u => u.status === 'ACTIVE').length,
      critical: allUsers.filter(u => u.status === 'CRITICAL').length,
      highlyCritical: allUsers.filter(u => u.status === 'HIGHLY_CRITICAL').length,
      inactive: allUsers.filter(u => u.status === 'INACTIVE').length,
      total: allUsers.length
    };

    res.json({
      data: usersFormatted,
      stats: stats,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (err) {
    console.error('Error fetching attendance:', err);
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});


// ═══════════════════════════════════════════════════════════════
// -------------------------- ISSUES ENDPOINTS -------------------
// ═══════════════════════════════════════════════════════════════

app.get('/api/issues', authMiddleware, async (req, res) => {
  try {
    const { status, priority } = req.query;
    // console.log("status and priority: ", status, priority);
    const where = {};
    if (status) {
      where.status = status.toUpperCase();
    }
    if (priority) {
      where.priority = priority.toUpperCase();
    }

    const issues = await prisma.issue.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { createdAt: 'desc' }
    });

    // console.log("issues are: ", issues);
    res.json({ data: issues });
  } catch (err) {
    console.error('Get issues error:', err);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

/**
 * POST /api/issues
 * Create a new issue
 */
app.post('/api/issues', authMiddleware, async (req, res) => {
  try {
    const { title, description, playerName, priority } = req.body;

    // Validation
    if (!title || !description) {
      return res.status(400).json({
        error: 'Title and description are required'
      });
    }

    const validPriorities = ['LOW', 'MEDIUM', 'HIGH'];
    const issuePriority = priority?.toUpperCase() || 'MEDIUM';

    if (!validPriorities.includes(issuePriority)) {
      return res.status(400).json({
        error: 'Priority must be LOW, MEDIUM, or HIGH'
      });
    }

    // Create issue
    const newIssue = await prisma.issue.create({
      data: {
        title: title.trim(), // this w
        description: description.trim(),
        playerName: playerName?.trim() || null,
        priority: issuePriority,
        status: 'UNRESOLVED',
        createdAt: new Date()
      }
    });

    res.status(201).json({
      data: newIssue,
      message: 'Issue submitted successfully'
    });
  } catch (err) {
    console.error('Create issue error:', err);
    res.status(500).json({ error: 'Failed to create issue' });
  }
});

/**
 * POST /api/issues/:issueId/resolve
 * Mark issue as resolved
 */
app.post('/api/issues/:issueId/resolve', authMiddleware, async (req, res) => {
  try {
    const { issueId } = req.params;

    const issue = await prisma.issue.findUnique({
      where: { id: parseInt(issueId) }
    });

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    // Mark as resolved
    const resolvedIssue = await prisma.issue.update({
      where: { id: parseInt(issueId) },
      data: {
        status: 'RESOLVED',
        updatedAt: new Date()
      }
    });

    res.json({
      data: resolvedIssue,
      message: 'Issue marked as resolved'
    });
  } catch (err) {
    console.error('Resolve issue error:', err);
    res.status(500).json({ error: 'Failed to resolve issue' });
  }
});

/**
 * GET /api/shifts
 * Get shift
 */
// ═══════════════════════════════════════════════════════════════
//  REPORT + FIXED SHIFT ROUTES  ── paste into server.js
//  Place this block just BEFORE the health-check section.
//
//  WHAT CHANGED VS. OLD ShiftsPage:
//    ✗ Old: startTime kept only in a useRef — lost on page refresh,
//           only written to DB when shift ENDS via api.shifts.createShift
//    ✓ New: POST /api/shifts/start  → writes immediately, returns shift.id
//           PATCH /api/shifts/:id/end → closes the record
//           GET  /api/shifts/active/:role → restores button state on mount
// ═══════════════════════════════════════════════════════════════

// ── helper ────────────────────────────────────────────────────────


app.get('/api/shifts/:role', authMiddleware, async (req, res) => {
  try {
    const { role } = req.params; // e.g. "TEAM1"

    const teamShifts = await prisma.shift.findMany({
      where: { teamRole: role },  // ✅ this field EXISTS now in your schema
      orderBy: { createdAt: 'desc' }
    });

    if (!teamShifts.length) {
      return res.status(404).json({ error: 'No shifts found for this team' });
    }

    res.json({
      data: teamShifts,
      message: 'Successfully retrieved shift records'
    });

  } catch (err) {
    console.error('error:', err);
    res.status(500).json({ error: 'Failed to show shift record' });
  }
});

/**
 * POST /api/shifts
 * Create a new shift
 */
app.post('/api/shifts', async (req, res) => {
  try {
    const { teamRole, startTime, endTime, duration, isActive } = req.body;

    const shift = await prisma.shift.create({
      data: {
        teamRole: teamRole,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        duration,
        isActive,
        team: {
          create: {
            teamName: "Team Alpha" // ✅ matches schema 
          }
        }
      }
    });

    // Also update the team's isShiftActive flag
    // await prisma.team.update({
    //   where: { id: team.id },
    //   data: { isShiftActive: false }
    // });

    res.json({ success: true, data: shift });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


async function getOrCreateTeam(teamRole) {
  let team = await prisma.team.findFirst({ where: { teamName: teamRole } });
  if (!team) {
    team = await prisma.team.create({
      data: { teamName: teamRole, isShiftActive: false },
    });
  }
  return team;
}

// ── GET /api/shifts/active/:role ──────────────────────────────────
app.get('/api/shifts/active/:role', authMiddleware, async (req, res) => {
  try {
    const shift = await prisma.shift.findFirst({
      where: { teamRole: req.params.role, isActive: true },
      orderBy: { startTime: 'desc' },
    });
    res.json({ data: shift || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get active shift' });
  }
});

// ── POST /api/shifts/start ────────────────────────────────────────
app.post('/api/shifts/start', authMiddleware, async (req, res) => {
  try {
    const { teamRole } = req.body;
    if (!teamRole) return res.status(400).json({ error: 'teamRole is required' });

    // Close any stale open shifts for this role first
    await prisma.shift.updateMany({
      where: { teamRole, isActive: true },
      data: { isActive: false, endTime: new Date() },
    });

    const team = await getOrCreateTeam(teamRole);
    await prisma.team.update({ where: { id: team.id }, data: { isShiftActive: true } });

    const shift = await prisma.shift.create({
      data: { teamId: team.id, teamRole, startTime: new Date(), isActive: true },
    });
    res.status(201).json({ data: shift, message: 'Shift started' });
  } catch (err) {
    console.error('Start shift error:', err);
    res.status(500).json({ error: 'Failed to start shift: ' + err.message });
  }
});

// ── PATCH /api/shifts/:id/end ─────────────────────────────────────
app.patch('/api/shifts/:id/end', authMiddleware, async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const existing = await prisma.shift.findUnique({ where: { id: shiftId } });
    if (!existing) return res.status(404).json({ error: 'Shift not found' });

    const now = new Date();
    const duration = Math.round((now - new Date(existing.startTime)) / 60000);

    const [updated] = await prisma.$transaction([
      prisma.shift.update({
        where: { id: shiftId },
        data: { endTime: now, duration, isActive: false },
      }),
      prisma.team.updateMany({
        where: { teamName: existing.teamRole },
        data: { isShiftActive: false },
      }),
    ]);
    res.json({ data: updated, message: 'Shift ended' });
  } catch (err) {
    console.error('End shift error:', err);
    res.status(500).json({ error: 'Failed to end shift: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  REPORT ENDPOINTS
// ═══════════════════════════════════════════════════════════════
function sumField(arr, field) {
  return arr.reduce((s, r) => s + parseFloat(r[field] || 0), 0);
}
function f2(n) { return parseFloat(n.toFixed(2)); }

const BONUS_TYPES = ['BONUS', 'MATCH_BONUS', 'SPECIAL'];

async function enrichShift(shift) {
  const shiftEnd = shift.endTime || new Date();

  const [transactions, tasks] = await Promise.all([
    prisma.transaction.findMany({
      where: { createdAt: { gte: shift.startTime, lte: shiftEnd }, status: 'COMPLETED' },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.task.findMany({
      where: {
        status: 'COMPLETED',
        completedAt: { gte: shift.startTime, lte: shiftEnd },
        assignedTo: { role: shift.teamRole },
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }).catch(() => []),
  ]);

  const deposits = transactions.filter(t => t.type === 'DEPOSIT');
  const cashouts = transactions.filter(t => t.type === 'WITHDRAWAL');
  const bonusTxns = transactions.filter(t => BONUS_TYPES.includes(t.type));

  const totalDeposits = sumField(deposits, 'amount');
  const totalCashouts = sumField(cashouts, 'amount');
  const totalBonuses = sumField(bonusTxns, 'amount');

  return {
    ...shift,
    stats: {
      tasksCompleted: tasks.length,
      depositCount: deposits.length,
      cashoutCount: cashouts.length,
      bonusCount: bonusTxns.length,
      totalDeposits: f2(totalDeposits),
      totalCashouts: f2(totalCashouts),
      totalBonuses: f2(totalBonuses),
      netProfit: f2(totalDeposits - totalCashouts - totalBonuses),
      transactionCount: transactions.length,
    },
    tasks,
    transactions,
  };
}

// ── GET /api/reports/daily  (admin) ───────────────────────────────
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
    const teamUsers = await prisma.user.findMany({
      where: { role: { in: roles } },
      select: { id: true, name: true, username: true, role: true },
    });

    const teams = roles.map(role => ({
      role,
      member: teamUsers.find(u => u.role === role) || null,
      shifts: enrichedShifts.filter(s => s.teamRole === role),
    }));

    const allDayTxns = await prisma.transaction.findMany({
      where: { createdAt: { gte: dayStart, lte: dayEnd }, status: 'COMPLETED' },
    });
    const dayDeposits = sumField(allDayTxns.filter(t => t.type === 'DEPOSIT'), 'amount');
    const dayCashouts = sumField(allDayTxns.filter(t => t.type === 'WITHDRAWAL'), 'amount');
    const dayBonuses = sumField(allDayTxns.filter(t => BONUS_TYPES.includes(t.type)), 'amount');

    const dayTasks = await prisma.task.findMany({
      where: { completedAt: { gte: dayStart, lte: dayEnd }, status: 'COMPLETED' },
      include: {
        assignedTo: { select: { id: true, name: true, role: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }).catch(() => []);

    const wallets = await prisma.wallet.findMany({ orderBy: [{ method: 'asc' }, { name: 'asc' }] });

    res.json({
      date: dayStart.toISOString().split('T')[0],
      teams,
      wallets: wallets.map(w => ({ id: w.id, name: w.name, method: w.method, balance: parseFloat(w.balance) })),
      dayTasks,
      summary: {
        totalDeposits: f2(dayDeposits),
        totalCashouts: f2(dayCashouts),
        totalBonuses: f2(dayBonuses),
        netProfit: f2(dayDeposits - dayCashouts - dayBonuses),
        totalShifts: enrichedShifts.length,
        activeShifts: enrichedShifts.filter(s => s.isActive).length,
        tasksCompleted: dayTasks.length,
        transactionCount: allDayTxns.length,
      },
    });
  } catch (err) {
    console.error('Daily report error:', err);
    res.status(500).json({ error: 'Failed to generate report: ' + err.message });
  }
});

// ── GET /api/reports/my-shifts  (team member) ────────────────────
app.get('/api/reports/my-shifts', authMiddleware, async (req, res) => {
  try {
    const role = req.query.role || req.userRole;
    const limit = parseInt(req.query.limit) || 30;

    const shifts = await prisma.shift.findMany({
      where: { teamRole: role },
      orderBy: { startTime: 'desc' },
      take: limit,
    });

    const enriched = await Promise.all(shifts.map(enrichShift));
    res.json({ data: enriched });
  } catch (err) {
    console.error('My-shifts report error:', err);
    res.status(500).json({ error: 'Failed to fetch shift reports' });
  }
});


// ═══════════════════════════════════════════════════════════════
// -------------------------- Charts/Graphs ENDPOINTS -------------------
// ═══════════════════════════════════════════════════════════════
// 
/**  * GET /api/chart/daily-profit
 * Get daily profit data for last 7 days
 */
app.get('/api/chart/daily-profit', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const days = 7;
    const chartData = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);

      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);

      const [deposits, withdrawals] = await Promise.all([
        prisma.transaction.aggregate({
          where: {
            type: 'DEPOSIT',
            status: 'COMPLETED',
            createdAt: { gte: date, lt: nextDate }
          },
          _sum: { amount: true }
        }),
        prisma.transaction.aggregate({
          where: {
            type: 'WITHDRAWAL',
            status: 'COMPLETED',
            createdAt: { gte: date, lt: nextDate }
          },
          _sum: { amount: true }
        })
      ]);

      const depositAmount = parseFloat(deposits._sum.amount || 0);
      const withdrawalAmount = parseFloat(withdrawals._sum.amount || 0);
      const profit = depositAmount - withdrawalAmount;

      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const dayName = dayNames[date.getDay()];

      chartData.push({
        day: dayName,
        profit: Math.round(profit)
      });
    }

    res.json({ data: chartData });
  } catch (err) {
    console.error('Get daily profit error:', err);
    res.status(500).json({ error: 'Failed to fetch daily profit data' });
  }
});

/**  * GET /api/chart/player-activity
 * Get player activity data for last 7 days
 */
app.get('/api/chart/player-activity', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const days = 7;
    const chartData = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);

      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);

      const deposits = await prisma.transaction.aggregate({
        where: {
          type: 'DEPOSIT',
          status: 'COMPLETED',
          createdAt: { gte: date, lt: nextDate }
        },
        _sum: { amount: true }
      });

      const depositAmount = parseFloat(deposits._sum.amount || 0);

      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const dayName = dayNames[date.getDay()];

      chartData.push({
        name: dayName,
        deposits: Math.round(depositAmount)
      });
    }

    console.log('Player Activity Chart Data:', chartData);
    res.json({ data: chartData });
  } catch (err) {
    console.error('Get player activity error:', err);
    res.status(500).json({ error: 'Failed to fetch player activity data' });
  }
});

/////// Chart to show deposit vs withdrwal for 7 and 30 days
app.get('/api/chart/player-deposit-withdrawal', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const getChartData = async (days) => {
      const chartData = [];

      for (let i = days - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        date.setHours(0, 0, 0, 0);

        const nextDate = new Date(date);// means
        nextDate.setDate(nextDate.getDate() + 1);

        const deposits = await prisma.transaction.aggregate({
          where: {
            type: 'DEPOSIT', status: 'COMPLETED', createdAt: { gte: date, lt: nextDate }
          },
          _sum: { amount: true }
        });

        const withdrawals = await prisma.transaction.aggregate({
          where: {
            type: 'WITHDRAWAL', status: 'COMPLETED', createdAt: { gte: date, lt: nextDate }
          },
          _sum: { amount: true }
        });

        chartData.push({
          date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          deposits: parseFloat(deposits._sum.amount || 0),
          withdrawals: parseFloat(withdrawals._sum.amount || 0),
        })
      }

      return chartData
    }

    const period_7days = await getChartData(7);
    const period_30days = await getChartData(30);
    console.log('Deposit vs Withdrawal - 7 Days:', period_7days);
    console.log('Deposit vs Withdrawal - 30 Days:', period_30days);
    res.json({ period_7days, period_30days });
  } catch (err) {
    console.error('Error fetching player activity:', err);
    res.status(500).json({ error: 'Failed to fetch player activity data' });
  }

});

// ═══════════════════════════════════════════════════════════════
// TASK ENDPOINTS
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// TASKS + REAL-TIME SSE  — paste this block into server.js
// (place it just before the "HEALTH CHECK" section at the bottom)
// ═══════════════════════════════════════════════════════════════

// ── SSE client registry ──────────────────────────────────────────
// Map<userId, Set<res>>  — one user can have multiple browser tabs
const sseClients = new Map();

function broadcastTaskEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const clients of sseClients.values()) {
    for (const res of clients) {
      try { res.write(payload); } catch (_) { /* skip dead connections */ }
    }
  }
}

// ── SSE handshake ─────────────────────────────────────────────────
// IMPORTANT: This route MUST be registered BEFORE any /api/tasks/:id route
// in server.js, otherwise Express matches "events" as an :id param.
//
// Auth is handled manually here (not via authMiddleware) because:
//   • res.setHeader must be called before any res.json / error response
//   • EventSource can't send Authorization headers — relies on cookies
//   • authMiddleware calling res.json() after flushHeaders() crashes the stream
app.get('/api/tasks/events', (req, res) => {
  // ── Set SSE headers FIRST before any auth check ───────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders(); // headers committed — no res.json() after this point

  // ── Manual auth after flush (errors sent as SSE error events) ─
  let userId;
  try {
    // Works whether your auth uses cookies or the Authorization header
    const token =
      req.cookies?.token ||
      req.cookies?.authToken ||
      req.headers?.authorization?.replace('Bearer ', '');

    if (!token) throw new Error('No token');

    // Use the same JWT verification your authMiddleware uses
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.id || decoded.userId;
    if (!userId) throw new Error('No userId in token');
  } catch (err) {
    console.warn('[SSE] Auth failed:', err.message);
    res.write('event: auth_error\ndata: {"error":"Unauthorized"}\n\n');
    res.end();
    return;
  }

  // ── Register client ────────────────────────────────────────────
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);

  // Confirm connection to client
  res.write('event: connected\ndata: {"ok":true}\n\n');

  // Keep-alive ping every 25 s (prevents proxy/load-balancer timeouts)
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.get(userId)?.delete(res);
    if (sseClients.get(userId)?.size === 0) sseClients.delete(userId);
  });
});

// ── Online presence ping ──────────────────────────────────────────
// Team members POST this every 30 s to mark themselves online.
const onlineUsers = new Map(); // userId → lastSeen timestamp

app.post('/api/tasks/ping', authMiddleware, (req, res) => {
  onlineUsers.set(req.userId, Date.now());
  res.json({ ok: true });
});

app.get('/api/tasks/online', authMiddleware, adminMiddleware, (req, res) => {
  const threshold = Date.now() - 45000; // 45 s window
  const online = [];
  for (const [uid, ts] of onlineUsers.entries()) {
    if (ts >= threshold) online.push(uid);
  }
  res.json({ data: online });
});

// ── GET /api/tasks ────────────────────────────────────────────────
// Returns all tasks. Optional ?assignedTo=<userId>  or ?unassigned=true
app.get('/api/tasks', authMiddleware, async (req, res) => {
  try {
    const { assignedTo, unassigned, status } = req.query;

    const where = {};
    if (unassigned === 'true') where.assignedToId = null;
    else if (assignedTo) where.assignedToId = parseInt(assignedTo);
    if (status) where.status = status.toUpperCase();

    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        assignedTo: { select: { id: true, name: true, role: true } },
      },
    });

    res.json({ data: tasks });
  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// ── POST /api/tasks ───────────────────────────────────────────────
// Admin creates a task, optionally assigns it immediately
app.post('/api/tasks', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, description, priority, dueDate, assignedToId, notes } = req.body;

    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

    const task = await prisma.task.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        priority: priority?.toUpperCase() || 'MEDIUM',
        dueDate: dueDate ? new Date(dueDate) : null,
        assignedToId: assignedToId ? parseInt(assignedToId) : null,
        notes: notes?.trim() || null,
        createdById: req.userId,
        status: 'PENDING',
      },
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        assignedTo: { select: { id: true, name: true, role: true } },
      },
    });

    broadcastTaskEvent('task_created', task);
    res.status(201).json({ data: task, message: 'Task created successfully' });
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// ── PATCH /api/tasks/:id ──────────────────────────────────────────
// Update status, assign/unassign, edit fields
app.patch('/api/tasks/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid task ID' });

    const { title, description, priority, status, dueDate, assignedToId, notes } = req.body;

    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const data = {};
    if (title !== undefined) data.title = title.trim();
    if (description !== undefined) data.description = description?.trim() || null;
    if (priority !== undefined) data.priority = priority.toUpperCase();
    if (status !== undefined) {
      data.status = status.toUpperCase();
      if (status.toUpperCase() === 'COMPLETED') data.completedAt = new Date();
      if (status.toUpperCase() !== 'COMPLETED') data.completedAt = null;
    }
    if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
    if (assignedToId !== undefined) data.assignedToId = assignedToId ? parseInt(assignedToId) : null;
    if (notes !== undefined) data.notes = notes?.trim() || null;

    const updated = await prisma.task.update({
      where: { id },
      data,
      include: {
        createdBy: { select: { id: true, name: true, role: true } },
        assignedTo: { select: { id: true, name: true, role: true } },
      },
    });

    broadcastTaskEvent('task_updated', updated);
    res.json({ data: updated, message: 'Task updated successfully' });
  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// ── DELETE /api/tasks/:id ─────────────────────────────────────────
app.delete('/api/tasks/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid task ID' });

    await prisma.task.delete({ where: { id } });
    broadcastTaskEvent('task_deleted', { id });
    res.json({ message: 'Task deleted' });
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ── GET /api/team-members ─────────────────────────────────────────
// Returns all team members (TEAM1–TEAM4) for the assign dropdown
app.get('/api/team-members', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const members = await prisma.user.findMany({
      where: { role: { in: ['TEAM1', 'TEAM2', 'TEAM3', 'TEAM4'] } },
      select: { id: true, name: true, username: true, role: true, email: true },
      orderBy: { name: 'asc' },
    });
    res.json({ data: members });
  } catch (err) {
    console.error('Get team members error:', err);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});


// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

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
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         OceanBets Dashboard Backend Server                   ║
║                                                               ║
║  ✅ Server running at http://localhost:${PORT}                   ║
║  🌐 Frontend expects: ${FRONTEND_URL}                         ║
║  📊 Health check: http://localhost:${PORT}/health             ║
║                                                               ║
║  Available endpoints:                                         ║
║  • POST   /api/login                                          ║
║  • POST   /api/logout                                         ║
║  • GET    /api/user                                           ║
║  • GET    /api/dashboard/stats                                ║
║  • GET    /api/players                                        ║
║  • GET    /api/transactions                                   ║
║  • POST   /api/transactions/:id/undo                          ║
║  • GET    /api/games                                          ║
║  • GET    /api/attendance                                     ║
║  • GET    /api/issues                                         ║
║  • GET    /api/chart/daily-profit                             ║
║  • GET    /api/chart/player-activity                          ║
║                                                               ║
║  📝 Make sure to:                                             ║
║  1. Set JWT_SECRET in .env                                   ║
║  2. Set DATABASE_URL in .env                                 ║
║  3. Run: npx prisma migrate dev                              ║
║  4. Run: node prisma/enhanced-seed.js                         ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

// module.exports = app;
export default app;