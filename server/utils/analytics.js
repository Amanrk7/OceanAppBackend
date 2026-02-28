const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Calculate dashboard statistics
async function getDashboardStats() {
  const [
    totalUsers,
    activeUsers,
    suspendedUsers,
    totalTransactions,
    pendingTransactions,
    totalDeposits,
    totalWithdrawals,
    totalBonuses,
    tierDistribution
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'PLAYER' } }),
    prisma.user.count({ where: { role: 'PLAYER', status: 'ACTIVE' } }),
    prisma.user.count({ where: { role: 'PLAYER', status: 'SUSPENDED' } }),
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
    prisma.transaction.aggregate({
      where: { type: { in: ['BONUS', 'FREEPLAY', 'REFERRAL'] }, status: 'COMPLETED' },
      _sum: { amount: true }
    }),
    prisma.user.groupBy({
      by: ['tier'],
      where: { role: 'PLAYER' },
      _count: true
    })
  ]);

  return {
    users: {
      total: totalUsers,
      active: activeUsers,
      suspended: suspendedUsers,
      tiers: {
        bronze: tierDistribution.find(t => t.tier === 'BRONZE')?._count || 0,
        silver: tierDistribution.find(t => t.tier === 'SILVER')?._count || 0,
        gold: tierDistribution.find(t => t.tier === 'GOLD')?._count || 0
      }
    },
    transactions: {
      total: totalTransactions,
      pending: pendingTransactions
    },
    revenue: {
      totalDeposits: Number(totalDeposits._sum.amount || 0),
      totalWithdrawals: Number(totalWithdrawals._sum.amount || 0),
      totalBonuses: Number(totalBonuses._sum.amount || 0),
      netRevenue: Number(totalDeposits._sum.amount || 0) - Number(totalWithdrawals._sum.amount || 0)
    }
  };
}

// Get transaction trends (last 7 days)
async function getTransactionTrends() {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const transactions = await prisma.transaction.findMany({
    where: {
      createdAt: { gte: sevenDaysAgo },
      status: 'COMPLETED'
    },
    select: {
      type: true,
      amount: true,
      createdAt: true
    }
  });

  // Group by date
  const trendMap = {};
  transactions.forEach(t => {
    const date = t.createdAt.toISOString().split('T')[0];
    if (!trendMap[date]) {
      trendMap[date] = { deposits: 0, withdrawals: 0, bonuses: 0 };
    }
    if (t.type === 'DEPOSIT') trendMap[date].deposits += Number(t.amount);
    if (t.type === 'WITHDRAWAL') trendMap[date].withdrawals += Number(t.amount);
    if (['BONUS', 'FREEPLAY', 'REFERRAL'].includes(t.type)) trendMap[date].bonuses += Number(t.amount);
  });

  return Object.entries(trendMap).map(([date, data]) => ({
    date,
    ...data
  }));
}

// Get top players by balance
async function getTopPlayers(limit = 10) {
  return await prisma.user.findMany({
    where: { role: 'PLAYER', status: 'ACTIVE' },
    orderBy: { balance: 'desc' },
    take: limit,
    select: {
      id: true,
      username: true,
      name: true,
      balance: true,
      tier: true,
      createdAt: true
    }
  });
}

// Get user growth stats
async function getUserGrowthStats() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const users = await prisma.user.findMany({
    where: {
      role: 'PLAYER',
      createdAt: { gte: thirtyDaysAgo }
    },
    select: {
      createdAt: true
    }
  });

  const growthMap = {};
  users.forEach(u => {
    const date = u.createdAt.toISOString().split('T')[0];
    growthMap[date] = (growthMap[date] || 0) + 1;
  });

  return Object.entries(growthMap).map(([date, count]) => ({
    date,
    newUsers: count
  }));
}

module.exports = {
  getDashboardStats,
  getTransactionTrends,
  getTopPlayers,
  getUserGrowthStats
};