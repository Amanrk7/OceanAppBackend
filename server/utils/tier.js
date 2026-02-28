const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Check and upgrade user tier
async function checkTierUpgrade(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tier: true, tierPoints: true }
  });

  if (!user) return;

  let newTier = user.tier;

  if (user.tierPoints >= 5000 && user.tier !== 'GOLD') {
    newTier = 'GOLD';
  } else if (user.tierPoints >= 1000 && user.tier === 'BRONZE') {
    newTier = 'SILVER';
  }

  if (newTier !== user.tier) {
    await prisma.user.update({
      where: { id: userId },
      data: { tier: newTier }
    });

    await prisma.activityLog.create({
      data: {
        userId,
        activityType: 'TIER_UPGRADED',
        description: `Tier upgraded from ${user.tier} to ${newTier}`
      }
    });

    // Create tier upgrade bonus
    const bonusAmounts = { SILVER: 50, GOLD: 100 };
    if (bonusAmounts[newTier]) {
      await prisma.bonus.create({
        data: {
          userId,
          type: 'LOYALTY',
          amount: bonusAmounts[newTier],
          description: `${newTier} tier upgrade bonus!`
        }
      });
    }

    console.log(`🎉 User ${userId} upgraded to ${newTier} tier!`);
  }
}

// Get tier configuration
async function getTierConfig(tier) {
  return await prisma.tierConfig.findUnique({
    where: { tier }
  });
}

// Validate deposit against tier limits
async function validateDepositLimit(userId, amount) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true, weeklyDeposit: true }
  });

  const tierConfig = await getTierConfig(user.tier);
  
  if (!tierConfig) {
    throw new Error('Tier configuration not found');
  }

  if (amount < tierConfig.minDeposit) {
    throw new Error(`Minimum deposit for ${user.tier} tier is $${tierConfig.minDeposit}`);
  }

  if (amount > tierConfig.maxDeposit) {
    throw new Error(`Maximum deposit for ${user.tier} tier is $${tierConfig.maxDeposit}`);
  }

  return true;
}

// Validate withdrawal against tier limits
async function validateWithdrawalLimit(userId, amount) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true }
  });

  const tierConfig = await getTierConfig(user.tier);
  
  if (!tierConfig) {
    throw new Error('Tier configuration not found');
  }

  if (amount > tierConfig.dailyCashoutLimit) {
    throw new Error(`Daily cashout limit for ${user.tier} tier is $${tierConfig.dailyCashoutLimit}`);
  }

  return true;
}

// Reset weekly deposits (run weekly via cron)
async function resetWeeklyDeposits() {
  await prisma.user.updateMany({
    where: { role: 'PLAYER' },
    data: { weeklyDeposit: 0 }
  });
  console.log('✅ Weekly deposits reset for all players');
}

module.exports = {
  checkTierUpgrade,
  getTierConfig,
  validateDepositLimit,
  validateWithdrawalLimit,
  resetWeeklyDeposits
};