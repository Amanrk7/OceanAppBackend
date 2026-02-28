const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authMiddleware } = require('./middleware/auth');
const { adminMiddleware, superAdminMiddleware } = require('./middleware/adminAuth');
const { getDashboardStats, getTransactionTrends, getTopPlayers } = require('./utils/analytics');
const { exportUsers, exportTransactions } = require('./utils/export');

const router = express.Router();
const prisma = new PrismaClient();

// All admin routes require authentication + admin role
router.use(authMiddleware);
router.use(adminMiddleware);

// ═══════════════════════════════════════════════════════════════
// DASHBOARD & ANALYTICS
// ═══════════════════════════════════════════════════════════════

// Get admin dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await getDashboardStats();
    res.json(stats);
  } catch (err) {
    console.error('Get stats error:', err);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get transaction trends
router.get('/trends', async (req, res) => {
  try {
    const trends = await getTransactionTrends();
    res.json(trends);
  } catch (err) {
    console.error('Get trends error:', err);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
});

// Get top players
router.get('/top-players', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const players = await getTopPlayers(limit);
    res.json(players.map(p => ({
      ...p,
      balance: Number(p.balance)
    })));
  } catch (err) {
    console.error('Get top players error:', err);
    res.status(500).json({ error: 'Failed to fetch top players' });
  }
});

// ═══════════════════════════════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// Get all users (with pagination and filters)
router.get('/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    const where = { role: 'PLAYER' };
    
    // Filters
    if (req.query.status) where.status = req.query.status;
    if (req.query.search) {
      where.OR = [
        { username: { contains: req.query.search, mode: 'insensitive' } },
        { name: { contains: req.query.search, mode: 'insensitive' } },
        { email: { contains: req.query.search, mode: 'insensitive' } }
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          balance: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          _count: {
            select: {
              transactions: true,
              bonuses: true
            }
          }
        }
      }),
      prisma.user.count({ where })
    ]);

    res.json({
      users: users.map(u => ({
        ...u,
        balance: Number(u.balance),
        transactionCount: u._count.transactions,
        bonusCount: u._count.bonuses
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get single user details
router.get('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 20
        },
        bonuses: {
          orderBy: { createdAt: 'desc' }
        },
        activityLogs: {
          orderBy: { createdAt: 'desc' },
          take: 50
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      ...user,
      balance: Number(user.balance),
      transactions: user.transactions.map(t => ({
        ...t,
        amount: Number(t.amount),
        bonus: Number(t.bonus)
      })),
      bonuses: user.bonuses.map(b => ({
        ...b,
        amount: Number(b.amount)
      }))
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user
router.put('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { name, email, status, balance } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (status) updateData.status = status;
    if (balance !== undefined) updateData.balance = Number(balance);

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: req.userId,
        activityType: 'USER_UPDATED',
        description: `Admin updated user ${user.username}`
      }
    });

    res.json({
      message: 'User updated successfully',
      user: {
        ...user,
        balance: Number(user.balance)
      }
    });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Suspend/Activate user
router.post('/users/:id/suspend', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { suspend, reason } = req.body;

    const user = await prisma.user.update({
      where: { id: userId },
      data: { status: suspend ? 'SUSPENDED' : 'ACTIVE' }
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId,
        activityType: 'USER_SUSPENDED',
        description: suspend 
          ? `Account suspended: ${reason || 'No reason provided'}` 
          : 'Account activated'
      }
    });

    res.json({
      message: suspend ? 'User suspended' : 'User activated',
      user: {
        ...user,
        balance: Number(user.balance)
      }
    });
  } catch (err) {
    console.error('Suspend user error:', err);
    res.status(500).json({ error: 'Failed to suspend/activate user' });
  }
});

// Adjust user balance (manual adjustment)
router.post('/users/:id/adjust-balance', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { amount, reason } = req.body;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const numAmount = Number(amount);

    // Update balance and create transaction
    const [user, transaction] = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: numAmount } }
      });

      const newTransaction = await tx.transaction.create({
        data: {
          userId,
          type: 'ADJUSTMENT',
          amount: Math.abs(numAmount),
          notes: reason || 'Manual adjustment by admin',
          status: 'COMPLETED'
        }
      });

      return [updatedUser, newTransaction];
    });

    res.json({
      message: 'Balance adjusted successfully',
      balance: Number(user.balance),
      transaction: {
        ...transaction,
        amount: Number(transaction.amount)
      }
    });
  } catch (err) {
    console.error('Adjust balance error:', err);
    res.status(500).json({ error: 'Failed to adjust balance' });
  }
});

// ═══════════════════════════════════════════════════════════════
// TRANSACTION MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// Get all transactions (with filters)
router.get('/transactions', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const where = {};
    
    if (req.query.userId) where.userId = parseInt(req.query.userId);
    if (req.query.type) where.type = req.query.type;
    if (req.query.status) where.status = req.query.status;
    if (req.query.startDate) {
      where.createdAt = { 
        gte: new Date(req.query.startDate),
        ...(req.query.endDate && { lte: new Date(req.query.endDate) })
      };
    }

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { username: true, name: true, email: true }
          }
        }
      }),
      prisma.transaction.count({ where })
    ]);

    res.json({
      transactions: transactions.map(t => ({
        ...t,
        amount: Number(t.amount),
        bonus: Number(t.bonus)
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Get transactions error:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Approve/Reject pending transaction
router.post('/transactions/:id/review', async (req, res) => {
  try {
    const transactionId = parseInt(req.params.id);
    const { approve, notes } = req.body;

    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { user: true }
    });

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (transaction.status !== 'PENDING') {
      return res.status(400).json({ error: 'Transaction already processed' });
    }

    const newStatus = approve ? 'COMPLETED' : 'REJECTED';

    // Update transaction
    const updated = await prisma.$transaction(async (tx) => {
      const txn = await tx.transaction.update({
        where: { id: transactionId },
        data: { 
          status: newStatus,
          notes: notes || (approve ? 'Approved by admin' : 'Rejected by admin')
        }
      });

      // If approved and it's a topup, add to balance
      if (approve && transaction.type === 'TOPUP') {
        await tx.user.update({
          where: { id: transaction.userId },
          data: { 
            balance: { 
              increment: Number(transaction.amount) + Number(transaction.bonus)
            }
          }
        });
      }

      // Log activity
      await tx.activityLog.create({
        data: {
          userId: transaction.userId,
          activityType: approve ? 'TRANSACTION_APPROVED' : 'TRANSACTION_REJECTED',
          description: `${transaction.type} transaction ${approve ? 'approved' : 'rejected'} by admin`
        }
      });

      return txn;
    });

    res.json({
      message: `Transaction ${approve ? 'approved' : 'rejected'}`,
      transaction: {
        ...updated,
        amount: Number(updated.amount),
        bonus: Number(updated.bonus)
      }
    });
  } catch (err) {
    console.error('Review transaction error:', err);
    res.status(500).json({ error: 'Failed to review transaction' });
  }
});

// ═══════════════════════════════════════════════════════════════
// BONUS MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// Get all bonuses
router.get('/bonuses', async (req, res) => {
  try {
    const where = {};
    
    if (req.query.userId) where.userId = parseInt(req.query.userId);
    if (req.query.claimed !== undefined) where.claimed = req.query.claimed === 'true';

    const bonuses = await prisma.bonus.findMany({
      where,
      include: {
        user: {
          select: { username: true, name: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(bonuses.map(b => ({
      ...b,
      amount: Number(b.amount)
    })));
  } catch (err) {
    console.error('Get bonuses error:', err);
    res.status(500).json({ error: 'Failed to fetch bonuses' });
  }
});

// Create bonus for user(s)
router.post('/bonuses', async (req, res) => {
  try {
    const { userIds, amount, reason, expiresAt } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'User IDs required' });
    }

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const bonusData = userIds.map(userId => ({
      userId: parseInt(userId),
      amount: Number(amount),
      reason: reason || 'Admin bonus',
      expiresAt: expiresAt ? new Date(expiresAt) : null
    }));

    const bonuses = await prisma.bonus.createMany({
      data: bonusData
    });

    res.json({
      message: `Bonus created for ${bonuses.count} user(s)`,
      count: bonuses.count
    });
  } catch (err) {
    console.error('Create bonus error:', err);
    res.status(500).json({ error: 'Failed to create bonus' });
  }
});

// Delete bonus
router.delete('/bonuses/:id', async (req, res) => {
  try {
    const bonusId = parseInt(req.params.id);

    const bonus = await prisma.bonus.findUnique({
      where: { id: bonusId }
    });

    if (!bonus) {
      return res.status(404).json({ error: 'Bonus not found' });
    }

    if (bonus.claimed) {
      return res.status(400).json({ error: 'Cannot delete claimed bonus' });
    }

    await prisma.bonus.delete({
      where: { id: bonusId }
    });

    res.json({ message: 'Bonus deleted successfully' });
  } catch (err) {
    console.error('Delete bonus error:', err);
    res.status(500).json({ error: 'Failed to delete bonus' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ACTIVITY LOGS
// ═══════════════════════════════════════════════════════════════

router.get('/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const skip = (page - 1) * limit;

    const where = {};
    
    if (req.query.userId) where.userId = parseInt(req.query.userId);
    if (req.query.activityType) where.activityType = req.query.activityType;

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { username: true, name: true }
          }
        }
      }),
      prisma.activityLog.count({ where })
    ]);

    res.json({
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Get logs error:', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTINGS (Super Admin Only)
// ═══════════════════════════════════════════════════════════════

router.get('/settings', superAdminMiddleware, async (req, res) => {
  try {
    const settings = await prisma.systemSetting.findMany();
    
    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.key] = s.value;
    });

    res.json(settingsMap);
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.put('/settings', superAdminMiddleware, async (req, res) => {
  try {
    const updates = req.body;

    const promises = Object.entries(updates).map(([key, value]) =>
      prisma.systemSetting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) }
      })
    );

    await Promise.all(promises);

    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ═══════════════════════════════════════════════════════════════
// EXPORT DATA
// ═══════════════════════════════════════════════════════════════

router.get('/export/users', async (req, res) => {
  try {
    const csv = await exportUsers();
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
    res.send(csv);
  } catch (err) {
    console.error('Export users error:', err);
    res.status(500).json({ error: 'Failed to export users' });
  }
});

router.get('/export/transactions', async (req, res) => {
  try {
    const csv = await exportTransactions(req.query);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
    res.send(csv);
  } catch (err) {
    console.error('Export transactions error:', err);
    res.status(500).json({ error: 'Failed to export transactions' });
  }
});

module.exports = router;