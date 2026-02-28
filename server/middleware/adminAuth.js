const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Admin-only middleware
const adminMiddleware = async (req, res, next) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true, status: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Account suspended' });
    }

    if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.userRole = user.role;
    next();
  } catch (err) {
    console.error('Admin auth error:', err);
    res.status(500).json({ error: 'Authorization failed' });
  }
};

// Super admin only middleware
const superAdminMiddleware = async (req, res, next) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true }
    });

    if (!user || user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Super admin access required' });
    }

    next();
  } catch (err) {
    console.error('Super admin auth error:', err);
    res.status(500).json({ error: 'Authorization failed' });
  }
};

module.exports = { adminMiddleware, superAdminMiddleware };