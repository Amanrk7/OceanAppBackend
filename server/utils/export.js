const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Generate CSV from data
function generateCSV(data, headers) {
  const headerRow = headers.join(',');
  const rows = data.map(row => 
    headers.map(h => {
      const key = h.toLowerCase().replace(/ /g, '');
      const val = row[key];
      return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val;
    }).join(',')
  );
  return [headerRow, ...rows].join('\n');
}

// Export users to CSV
async function exportUsers() {
  const users = await prisma.user.findMany({
    where: { role: 'PLAYER' },
    select: {
      id: true,
      username: true,
      name: true,
      email: true,
      phone: true,
      balance: true,
      tier: true,
      status: true,
      createdAt: true,
      lastLoginAt: true
    }
  });

  const headers = ['ID', 'Username', 'Name', 'Email', 'Phone', 'Balance', 'Tier', 'Status', 'Created At', 'Last Login'];
  const data = users.map(u => ({
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    phone: u.phone || '',
    balance: Number(u.balance),
    tier: u.tier,
    status: u.status,
    createdat: u.createdAt.toISOString(),
    lastlogin: u.lastLoginAt ? u.lastLoginAt.toISOString() : ''
  }));

  return generateCSV(data, headers);
}

// Export transactions to CSV
async function exportTransactions(filters = {}) {
  const where = {};
  
  if (filters.userId) where.userId = parseInt(filters.userId);
  if (filters.type) where.type = filters.type;
  if (filters.status) where.status = filters.status;
  if (filters.startDate) {
    where.createdAt = { gte: new Date(filters.startDate) };
    if (filters.endDate) {
      where.createdAt.lte = new Date(filters.endDate);
    }
  }

  const transactions = await prisma.transaction.findMany({
    where,
    include: {
      user: {
        select: { username: true, name: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  const headers = ['ID', 'Username', 'Type', 'Amount', 'Bonus', 'Payment Method', 'Status', 'Date'];
  const data = transactions.map(t => ({
    id: t.id,
    username: t.user.username,
    type: t.type,
    amount: Number(t.amount),
    bonus: Number(t.bonus),
    paymentmethod: t.paymentMethod || '',
    status: t.status,
    date: t.createdAt.toISOString()
  }));

  return generateCSV(data, headers);
}

module.exports = {
  exportUsers,
  exportTransactions,
  generateCSV
};