import { PrismaClient, Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import bcrypt from 'bcrypt';

const playersData = JSON.parse(
    readFileSync(new URL('../frontend/src/DemoData/players_data.json', import.meta.url), 'utf-8')
);

const prisma = new PrismaClient();

// ═══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════
const games = [
    {
        name: "Billion balls",
        slug: "billion-balls",
        pointStock: 9956.0,
        status: "HEALTHY",
    },
    {
        name: "Cash frenzy",
        slug: "cash-frenzy",
        pointStock: 10865.76,
        status: "HEALTHY",
    },
    {
        name: "Game Vault",
        slug: "game-vault",
        pointStock: 98700.95,
        status: "HEALTHY",
    },
    {
        name: "Gamrroom",
        slug: "gamrroom",
        pointStock: 6916.27,
        status: "HEALTHY",
    },
    {
        name: "Juwa",
        slug: "juwa",
        pointStock: 10535.62,
        status: "HEALTHY",
    },
    {
        name: "Milkyway",
        slug: "milkyway",
        pointStock: 6850.12,
        status: "HEALTHY",
    },
    {
        name: "Orionstar",
        slug: "orionstar",
        pointStock: 7185.94,
        status: "HEALTHY",
    },
    {
        name: "Panda Master",
        slug: "panda-master",
        pointStock: 7892.72,
        status: "HEALTHY",
    },
    {
        name: "Riversweeps",
        slug: "riversweeps",
        pointStock: 9282.3,
        status: "HEALTHY",
    },
    {
        name: "Ultrapanda",
        slug: "ultrapanda",
        pointStock: 10715.12,
        status: "HEALTHY",
    },
    {
        name: "Vblink",
        slug: "vblink",
        pointStock: 3028.92,
        status: "HEALTHY",
    },
    {
        name: "Vegassweeps",
        slug: "vegassweeps",
        pointStock: 7079.76,
        status: "HEALTHY",
    },
    {
        name: "Yolo",
        slug: "yolo",
        pointStock: 7610.96,
        status: "HEALTHY",
    },
];
function getRandomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomDecimal(min, max) {
    return parseFloat((Math.random() * (max - min) + min).toFixed(2));
}

function getRandomDateInLastDays(days) {
    const now = new Date();
    const pastDate = new Date(now.getTime() - Math.random() * days * 24 * 60 * 60 * 1000);
    return pastDate;
}

function getRandomPaymentMethod() {
    const methods = ['PAYPAL', 'STRIPE', 'CRYPTO', 'UPI', 'BANK_TRANSFER', 'WALLET'];
    return methods[getRandomNumber(0, methods.length - 1)];
}

// function getRandomGameName() {
//     const games = [
//         'Lucky Dragons', 'Ocean Treasures', 'Golden Lotus', 'Thunder Strikes',
//         'Mystical Forest', 'Diamond Rush', 'Royal Flush', 'Phoenix Rising',
//         'Aztec Gold', 'Wild Safari', 'Cherry Blast', 'Cosmic Quest',
//         'Fire Dragon', 'Monkey King', 'Fruit Festival', 'Rainbow Riches',
//         'Book of Ra', 'Starburst', 'Gonzo\'s Quest', 'Sweet Bonanza'
//     ];
//     return games[getRandomNumber(0, games.length - 1)];
// }

// ═══════════════════════════════════════════════════════════════
// ISSUE TEMPLATES
// ═══════════════════════════════════════════════════════════════

const issueTemplates = [
    {
        title: 'Login Error',
        description: 'User unable to login to account'
    },
    {
        title: 'Payment Not Received',
        description: 'Withdrawal processed but funds not received'
    },
    {
        title: 'Game Crash',
        description: 'Game crashed during gameplay'
    },
    {
        title: 'Bonus Not Applied',
        description: 'Deposit bonus was not credited to account'
    },
    {
        title: 'Account Locked',
        description: 'Account locked after failed login attempts'
    },
    {
        title: 'Withdrawal Rejected',
        description: 'Withdrawal request was rejected'
    },
    {
        title: 'Balance Discrepancy',
        description: 'Account balance does not match expected amount'
    },
    {
        title: 'Slow Performance',
        description: 'Platform experiencing lag and slow load times'
    },
    {
        title: 'Email Not Received',
        description: 'Verification email not received'
    },
    {
        title: 'Two Factor Auth Issue',
        description: 'Unable to complete 2FA verification'
    },
    {
        title: 'Betting Limit Issue',
        description: 'Betting limit not being enforced properly'
    },
    {
        title: 'Session Timeout',
        description: 'Session expires too quickly'
    },
    {
        title: 'Mobile App Crash',
        description: 'Mobile app crashes on specific devices'
    },
    {
        title: 'Payment Method Error',
        description: 'Payment method not accepted'
    },
    {
        title: 'Account Verification Failed',
        description: 'Identity verification rejected'
    }
];

// ═══════════════════════════════════════════════════════════════
// MAIN SEEDING FUNCTION
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log('🌱 Seeding enhanced database with complete datasets...\n');

    // Clean existing data
    console.log('🧹 Cleaning existing data...');
    await prisma.emailQueue.deleteMany();
    await prisma.rateLimit.deleteMany();
    await prisma.session.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.attendance.deleteMany();
    await prisma.activityLog.deleteMany();
    await prisma.bonus.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.profitStat.deleteMany();
    await prisma.issue.deleteMany();  // ← ADD THIS LINE
    await prisma.tierConfig.deleteMany();
    await prisma.systemSetting.deleteMany();
    await prisma.user.deleteMany();

    // ═══════════════════════════════════
    // CREATE TIER CONFIGURATIONS
    // ═══════════════════════════════════

    console.log('⚙️  Creating tier configurations...');
    await prisma.tierConfig.createMany({
        data: [
            {
                tier: 'BRONZE',
                minDeposit: 0,
                maxDeposit: 500,
                dailyCashoutLimit: 250,
                weeklyCashoutLimit: 1000,
                bonusMultiplier: 0.50,
                freeplayDaily: 2,
                freeplayWeekly: 10,
                pointsRequired: 0,
                benefits: ['2¢ daily freeplay', '50% deposit bonus', 'Basic support']
            },
            {
                tier: 'SILVER',
                minDeposit: 50,
                maxDeposit: 1000,
                dailyCashoutLimit: 500,
                weeklyCashoutLimit: 3000,
                bonusMultiplier: 0.75,
                freeplayDaily: 3,
                freeplayWeekly: 20,
                pointsRequired: 1000,
                benefits: ['3¢ daily freeplay', '75% deposit bonus', 'Priority support', 'Weekly spin-the-wheel']
            },
            {
                tier: 'GOLD',
                minDeposit: 100,
                maxDeposit: 5000,
                dailyCashoutLimit: 750,
                weeklyCashoutLimit: 5000,
                bonusMultiplier: 1.00,
                freeplayDaily: 5,
                freeplayWeekly: 35,
                pointsRequired: 5000,
                benefits: ['5¢ daily freeplay', '100% deposit bonus', 'VIP support', 'Daily spin-the-wheel', 'Cashback rewards']
            }
        ]
    });

    // ═══════════════════════════════════
    // CREATE USERS
    // ═══════════════════════════════════

    console.log('👥 Creating users...');
    const adminPassword = await bcrypt.hash('admin123', 12);
    const playerPassword = await bcrypt.hash('pass123', 12);
    const teamPassword = await bcrypt.hash('team123', 12);

    const superAdmin = await prisma.user.create({
        data: {
            username: 'superadmin',
            password: adminPassword,
            name: 'Super Admin',
            email: 'superadmin@oceanbets.com',
            role: 'SUPER_ADMIN',
            balance: 0,
            tier: 'GOLD'
        }
    });

    const admin = await prisma.user.create({
        data: {
            username: 'admin',
            password: adminPassword,
            name: 'Admin User',
            email: 'admin@oceanbets.com',
            role: 'ADMIN',
            balance: 0,
            tier: 'GOLD'
        }
    });
    const team1 = await prisma.user.create({
        data: {
            username: 'team1',
            password: teamPassword,
            name: 'T1',
            email: 'team1@oceanbets.com',
            role: 'TEAM1',
            // balance: 0,
            // tier: 'GOLD'
        }
    });
    const team2 = await prisma.user.create({
        data: {
            username: 'team2',
            password: teamPassword,
            name: 'T2',
            email: 'team2@oceanbets.com',
            role: 'TEAM2',
            // balance: 0,
            // tier: 'GOLD'
        }
    });
    const team3 = await prisma.user.create({
        data: {
            username: 'team3',
            password: teamPassword,
            name: 'T3',
            email: 'team3@oceanbets.com',
            role: 'TEAM3',
            // balance: 0,
            // tier: 'GOLD'
        }
    });
    const team4 = await prisma.user.create({
        data: {
            username: 'team4',
            password: teamPassword,
            name: 'T4',
            email: 'team4@oceanbets.com',
            role: 'TEAM4',
            // balance: 0,
            // tier: 'GOLD'
        }
    });

    // const playerNames = [
    //     'John Doe', 'Jane Smith', 'Alex Lee', 'Sarah Johnson', 'Mike Brown',
    //     'Emily Davis', 'Chris Wilson', 'Lisa Anderson', 'David Taylor', 'Jessica White',
    //     'James Martin', 'Patricia Harris', 'Robert Thomas', 'Jennifer Moore', 'Michael Jackson',
    //     'Linda Garcia', 'William Rodriguez', 'Barbara Miller', 'David Martinez', 'Susan Robinson',
    //     'Joseph Clark', 'Carol Lewis', 'Thomas Walker', 'Janet Young', 'Charles King',
    //     'Maria Wright', 'Christopher Lopez', 'Diane Hill', 'Mark Green', 'Joyce Adams',
    //     'Donald Nelson', 'Beverly Bennett', 'Steven Carter', 'Kathleen Mitchell', 'Paul Roberts',
    //     'Sammie Rogers', 'Andrew Peterson', 'Christine Peterson', 'Joshua Campbell', 'Deborah Parker',
    //     'Kenneth Evans', 'Teresa Edwards', 'Kevin Collins', 'Sara Reeves', 'Brian Bell',
    //     'Shelly Cruz', 'George Rivera', 'Alicia Jimenez', 'Edward Reyes', 'Arlene Morris'
    // ];

    // const tiers = ['BRONZE', 'SILVER', 'GOLD'];

    // Helper to map tier string to enum
    const mapTier = (tier) => {
        const map = { 'Gold': 'GOLD', 'Silver': 'SILVER', 'Bronze': 'BRONZE' };
        return map[tier] || 'BRONZE';
    };

    // Helper to map attendance to status enum
    const mapStatus = (attendance) => {
        const map = {
            'active': 'ACTIVE',
            'critical': 'CRITICAL',
            'highly-critical': 'HIGHLY_CRITICAL',
            'inactive': 'INACTIVE'
        };
        return map[attendance] || 'ACTIVE';
    };

    console.log('👥 Creating players from JSON data...');
    const users = [];

    for (const playerData of playersData) {
        const user = await prisma.user.create({
            data: {
                username: playerData.name.toLowerCase().replace(/\s+/g, '_'),
                password: playerPassword,
                name: playerData.name,
                email: playerData.socials.email,
                phone: playerData.socials.phone,
                role: 'PLAYER',
                status: mapStatus(playerData.attendance),
                tier: mapTier(playerData.tier),
                balance: getRandomDecimal(100, 5000),

                // Social media
                facebook: playerData.socials.facebook || null,
                telegram: playerData.socials.telegram || null,
                instagram: playerData.socials.instagram || null,
                twitterX: playerData.socials.x || null,
                snapchat: playerData.socials.snapchat || null,

                // Profile
                source: playerData.source || null,
                cashoutLimit: playerData.cashoutLimit,
                currentStreak: playerData.streak.currentStreak,
                lastPlayedDate: new Date(playerData.streak.lastPlayedDate),
                playTimeMinutes: playerData.tierProgress.playTimeMinutes,

                // Gamification
                winStreak: playerData.streak.currentStreak,
                longestStreak: playerData.streak.currentStreak,
                tierPoints: playerData.tierProgress.playTimeMinutes,

                lastLoginAt: getRandomDateInLastDays(7),
                lastActivityAt: new Date(playerData.streak.lastPlayedDate),
                createdAt: getRandomDateInLastDays(365)
            }
        });
        users.push({ ...user, _jsonData: playerData }); // keep JSON ref for transactions
    }

    console.log(`✅ Created ${users.length} players from JSON`);
    // After creating all users, connect some friends & referrals
    // (add this block at the end of the users section in seed.js)

    console.log('🔗 Connecting friends & referrals...');
    const playerUsers = users.filter(u => u.role === 'PLAYER');

    for (let i = 0; i < playerUsers.length; i++) {
        const user = playerUsers[i];
        const jsonData = user._jsonData;

        // referredBy: connect to first other player as referrer (or use jsonData if it has referral info)
        if (i > 0 && Math.random() > 0.6) {
            const referrer = playerUsers[Math.floor(Math.random() * i)];
            await prisma.user.update({
                where: { id: user.id },
                data: { referrer: { connect: { id: referrer.id } } }
            });
        }

        // friends: connect 1-3 random other players
        const friendCount = Math.floor(Math.random() * 3) + 1;
        const potentialFriends = playerUsers
            .filter(u => u.id !== user.id)
            .sort(() => Math.random() - 0.5)
            .slice(0, friendCount);

        if (potentialFriends.length) {
            await prisma.user.update({
                where: { id: user.id },
                data: { friends: { connect: potentialFriends.map(f => ({ id: f.id })) } }
            });
        }
    }
    console.log('✅ Friends & referrals connected');

    // Seed transactions FROM the JSON data
    console.log('💰 Seeding transactions from JSON...');
    for (const user of users) {
        const jsonData = user._jsonData;
        for (const txn of jsonData.transactionHistory) {
            const typeMap = {
                'deposit': 'DEPOSIT',
                'cashout': 'WITHDRAWAL',
                'bonus_credited': 'BONUS'
            };
            await prisma.transaction.create({
                data: {
                    userId: user.id,
                    type: typeMap[txn.type] || 'DEPOSIT',
                    amount: new Prisma.Decimal(txn.amount.toString()),
                    status: txn.status.toUpperCase(),
                    description: txn.type,
                    createdAt: new Date(txn.date)
                }
            });
        }
    }

    // Seed bonus tracker data
    console.log('🎁 Seeding bonuses from JSON...');
    for (const user of users) {
        const bonusData = user._jsonData.bonusTracker;
        if (bonusData.usedBonus > 0) {
            await prisma.bonus.create({
                data: {
                    userId: user.id,
                    type: 'LOYALTY',
                    amount: new Prisma.Decimal(bonusData.totalBonusEarned.toString()),
                    description: 'Historical bonus',
                    claimed: true,
                    claimedAt: new Date(),
                    wagerMet: new Prisma.Decimal(bonusData.usedBonus.toString())
                }
            });
        }
        if (bonusData.availableBonus > 0) {
            await prisma.bonus.create({
                data: {
                    userId: user.id,
                    type: 'DEPOSIT_MATCH',
                    amount: new Prisma.Decimal(bonusData.availableBonus.toString()),
                    description: 'Available bonus',
                    claimed: false,
                    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                }
            });
        }
    }
    // for (let i = 0; i < 50; i++) {
    //     const tier = tiers[getRandomNumber(0, 2)];
    //     const user = await prisma.user.create({
    //         data: {
    //             username: `player_${i + 1}`,
    //             password: playerPassword,
    //             name: playerNames[i],
    //             email: `player${i + 1}@oceanbets.com`,
    //             phone: `+1234567${String(i).padStart(3, '0')}`,
    //             role: 'PLAYER',
    //             balance: getRandomDecimal(100, 5000),
    //             tier,
    //             tierPoints: getRandomNumber(0, 7000),
    //             totalWagered: getRandomDecimal(1000, 50000),
    //             totalWon: getRandomDecimal(500, 40000),
    //             gamesPlayed: getRandomNumber(10, 500),
    //             winStreak: getRandomNumber(0, 20),
    //             longestStreak: getRandomNumber(5, 30),
    //             referredBy: i > 0 && Math.random() > 0.7 ? users[getRandomNumber(0, users.length - 1)].id : null,
    //             lastLoginAt: getRandomDateInLastDays(30),
    //             lastActivityAt: getRandomDateInLastDays(7),
    //             createdAt: getRandomDateInLastDays(365)
    //         }
    //     });
    //     users.push(user);
    // }
    // console.log(`✅ Created ${users.length} player users`);




    // ═══════════════════════════════════
    // CREATE GAMES DATA
    // ═══════════════════════════════════
    console.log('🎮 Creating games data...');
    // ── Games ────────────────────────────────────────────────────
    console.log('🎮 Creating games data...');
    for (const game of games) {
        const upserted = await prisma.game.upsert({
            where: { slug: game.slug },
            update: { pointStock: game.pointStock, status: game.status },
            create: game,
        });
        console.log(`  ✓ ${upserted.name} (${upserted.pointStock})`);
    }
    console.log(`✅ Seeded ${games.length} games successfully.`);


    // ═══════════════════════════════════════════════════════════════
    // 🔑 ADD THIS WALLET SEEDING SECTION TO YOUR seed.js
    // Insert this RIGHT AFTER the games section and BEFORE transactions
    // ═══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    // CREATE WALLETS (CRITICAL FOR TRANSACTIONS TO DISPLAY)
    // ═══════════════════════════════════════════════════════════════
    console.log('💳 Creating wallets...');

    const walletsData = [
        // ── Crypto wallets ────────────────────────────────────────────
        {
            name: 'Main Bitcoin Wallet',
            method: 'Bitcoin',
            identifier: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
            balance: 15420.50
        },
        {
            name: 'Ethereum Vault',
            method: 'Ethereum',
            identifier: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
            balance: 8750.25
        },
        {
            name: 'USDT Reserve',
            method: 'USDT',
            identifier: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
            balance: 22100.00
        },
        {
            name: 'Bitcoin Secondary',
            method: 'Bitcoin',
            identifier: '3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy',
            balance: 6800.75
        },

        // ── Chime accounts ────────────────────────────────────────────
        {
            name: 'Main Account',
            method: 'Chime',
            identifier: '$OceanBets',
            balance: 12500.00
        },
        {
            name: 'Backup Chime',
            method: 'Chime',
            identifier: '$OBSecondary',
            balance: 5400.50
        },
        {
            name: 'Dashaunquis',
            method: 'Chime',
            identifier: '$Dashaunquisnew9',
            balance: 3200.00
        },
        {
            name: 'Omar Fonseca',
            method: 'Chime',
            identifier: '$Omar-98',
            balance: 2800.25
        },
        {
            name: 'Grant Hale',
            method: 'Chime',
            identifier: '$GrantH',
            balance: 1950.00
        },

        // ── CashApp accounts ──────────────────────────────────────────
        {
            name: 'Primary CashApp',
            method: 'CashApp',
            identifier: '$OceanBetsPay',
            balance: 9500.00
        },
        {
            name: 'Secondary CashApp',
            method: 'CashApp',
            identifier: '$OBCashFlow',
            balance: 4200.75
        },
        {
            name: 'Business CashApp',
            method: 'CashApp',
            identifier: '$OBBizAccount',
            balance: 6300.50
        },

        // ── Venmo accounts ────────────────────────────────────────────
        {
            name: 'Main Venmo',
            method: 'Venmo',
            identifier: '@OceanBets',
            balance: 7300.00
        },
        {
            name: 'Business Venmo',
            method: 'Venmo',
            identifier: '@OBBusiness',
            balance: 3900.50
        },
        {
            name: 'Backup Venmo',
            method: 'Venmo',
            identifier: '@OBBackup',
            balance: 2100.25
        },

        // ── PayPal accounts ───────────────────────────────────────────
        {
            name: 'Business PayPal',
            method: 'PayPal',
            identifier: 'business@oceanbets.com',
            balance: 18500.00
        },
        {
            name: 'Personal PayPal',
            method: 'PayPal',
            identifier: 'payments@oceanbets.com',
            balance: 6700.25
        },

        // ── Zelle accounts ────────────────────────────────────────────
        {
            name: 'Primary Zelle',
            method: 'Zelle',
            identifier: 'zelle@oceanbets.com',
            balance: 11200.00
        },
        {
            name: 'Backup Zelle',
            method: 'Zelle',
            identifier: '+1-555-0123',
            balance: 4500.00
        },
        {
            name: 'Business Zelle',
            method: 'Zelle',
            identifier: '+1-555-0456',
            balance: 7800.00
        },
    ];

    const createdWallets = [];
    for (const walletData of walletsData) {
        const wallet = await prisma.wallet.create({ data: walletData });
        createdWallets.push(wallet);
        console.log(`  ✓ ${wallet.method} — ${wallet.name} ($${wallet.balance.toFixed(2)})`);
    }

    console.log(`✅ Created ${createdWallets.length} wallets with total balance: $${createdWallets.reduce((sum, w) => sum + w.balance, 0).toFixed(2)
        }`);

    // ═══════════════════════════════════════════════════════════════
    // NOW UPDATE TRANSACTION SEEDING TO USE ACTUAL WALLETS
    // ═══════════════════════════════════════════════════════════════

    // Replace your existing transaction seeding section with this:
    console.log('💰 Creating transactions WITH wallet references...');

    const transactionData = [];

    for (let i = 0; i < 300; i++) {
        const user = users[getRandomNumber(0, users.length - 1)];
        const daysAgo = getRandomNumber(0, 30);
        const timestamp = new Date();
        timestamp.setDate(timestamp.getDate() - daysAgo);
        timestamp.setHours(getRandomNumber(0, 23), getRandomNumber(0, 59), getRandomNumber(0, 59));

        let amount;
        let type;
        let status;
        let description = null;
        let notes = null;
        const rand = Math.random();

        // ✅ Pick a random wallet for this transaction
        const randomWallet = createdWallets[getRandomNumber(0, createdWallets.length - 1)];

        // ✅ Pick a random game occasionally
        const randomGame = Math.random() > 0.5 ? games[getRandomNumber(0, games.length - 1)] : null;

        if (rand < 0.4) {
            // DEPOSIT
            type = 'DEPOSIT';
            amount = getRandomDecimal(50, 500);
            status = Math.random() > 0.05 ? 'COMPLETED' : 'PENDING';

            // ✅ Create proper deposit description with wallet info
            description = randomGame
                ? `Deposit via ${randomWallet.method} ${randomWallet.name} — Game: ${randomGame.name}`
                : `Deposit via ${randomWallet.method} ${randomWallet.name}`;

            notes = `Wallet: ${randomWallet.method} - ${randomWallet.name}${randomGame ? ` | Game: ${randomGame.name}` : ''}`;

        } else if (rand < 0.7) {
            // WITHDRAWAL
            type = 'WITHDRAWAL';
            amount = getRandomDecimal(50, 300);
            status = Math.random() > 0.1 ? 'COMPLETED' : 'REJECTED';

            // ✅ Create proper cashout description with wallet info
            description = `Cashout via ${randomWallet.method} ${randomWallet.name}`;
            notes = `Wallet: ${randomWallet.method} - ${randomWallet.name}`;

        } else if (rand < 0.85) {
            // WIN
            type = 'WIN';
            amount = getRandomDecimal(10, 200);
            status = 'COMPLETED';
            description = randomGame ? `Win from ${randomGame.name}` : 'Win';

        } else if (rand < 0.92) {
            // LOSS
            type = 'LOSS';
            amount = getRandomDecimal(5, 100);
            status = 'COMPLETED';
            description = randomGame ? `Loss in ${randomGame.name}` : 'Loss';

        } else {
            // BONUS
            type = 'BONUS';
            amount = getRandomDecimal(5, 50);
            status = 'COMPLETED';

            // ✅ Create varied bonus types
            const bonusTypes = ['Match', 'Special', 'Streak', 'Referral'];
            const bonusType = bonusTypes[getRandomNumber(0, bonusTypes.length - 1)];

            description = randomGame
                ? `${bonusType} Bonus from ${randomGame.name} — via ${randomWallet.method}`
                : `${bonusType} Bonus`;

            notes = randomGame ? `Game: ${randomGame.name}` : null;
        }

        transactionData.push({
            userId: user.id,
            type,
            amount: new Prisma.Decimal(amount.toString()),
            bonus: type === 'DEPOSIT' ? new Prisma.Decimal((amount * 0.5).toString()) : new Prisma.Decimal('0'),
            paymentMethod: ['DEPOSIT', 'WITHDRAWAL'].includes(type) ? mapToPaymentMethod(randomWallet.method) : null,
            status,
            description,
            notes,
            createdAt: timestamp
        });
    }

    // Helper function to map wallet methods to PaymentMethod enum
    function mapToPaymentMethod(walletMethod) {
        if (!walletMethod) return null;
        const normalized = walletMethod.toUpperCase().trim();
        const enumMap = {
            'PAYPAL': 'PAYPAL',
            'BITCOIN': 'CRYPTO',
            'ETHEREUM': 'CRYPTO',
            'USDT': 'CRYPTO',
            'CHIME': 'WALLET',
            'CASHAPP': 'WALLET',
            'VENMO': 'WALLET',
            'ZELLE': 'BANK_TRANSFER',
        };
        return enumMap[normalized] || null;
    }

    // Bulk insert transactions
    const batchSize = 50;
    for (let i = 0; i < transactionData.length; i += batchSize) {
        const batch = transactionData.slice(i, i + batchSize);
        await prisma.transaction.createMany({ data: batch });
    }

    console.log(`✅ Created ${transactionData.length} transactions WITH proper wallet references`);



    // ═══════════════════════════════════
    // CREATE TRANSACTIONS
    // ═══════════════════════════════════

    // console.log('💰 Creating transactions...');
    // const transactionData = [];

    // for (let i = 0; i < 300; i++) {
    //     const user = users[getRandomNumber(0, users.length - 1)];
    //     const daysAgo = getRandomNumber(0, 30);
    //     const timestamp = new Date();
    //     timestamp.setDate(timestamp.getDate() - daysAgo);
    //     timestamp.setHours(getRandomNumber(0, 23), getRandomNumber(0, 59), getRandomNumber(0, 59));

    //     let amount;
    //     let type;
    //     let status;
    //     const rand = Math.random();

    //     if (rand < 0.4) {
    //         type = 'DEPOSIT';
    //         amount = getRandomDecimal(50, 500);
    //         status = Math.random() > 0.05 ? 'COMPLETED' : 'PENDING';
    //     } else if (rand < 0.7) {
    //         type = 'WITHDRAWAL';
    //         amount = getRandomDecimal(50, 300);
    //         status = Math.random() > 0.1 ? 'COMPLETED' : 'REJECTED';
    //     } else if (rand < 0.85) {
    //         type = 'WIN';
    //         amount = getRandomDecimal(10, 200);
    //         status = 'COMPLETED';
    //     } else if (rand < 0.92) {
    //         type = 'LOSS';
    //         amount = getRandomDecimal(5, 100);
    //         status = 'COMPLETED';
    //     } else {
    //         type = 'BONUS';
    //         amount = getRandomDecimal(5, 50);
    //         status = 'COMPLETED';
    //     }

    //     transactionData.push({
    //         userId: user.id,
    //         type,
    //         amount: new Prisma.Decimal(amount.toString()),
    //         bonus: type === 'DEPOSIT' ? new Prisma.Decimal((amount * 0.5).toString()) : new Prisma.Decimal('0'),
    //         paymentMethod: type === 'DEPOSIT' ? getRandomPaymentMethod() : null,
    //         status,
    //         description: `${type.toLowerCase()} transaction`,
    //         createdAt: timestamp
    //     });
    // }

    // const batchSize = 50;
    // for (let i = 0; i < transactionData.length; i += batchSize) {
    //     const batch = transactionData.slice(i, i + batchSize);
    //     await prisma.transaction.createMany({
    //         data: batch
    //     });
    // }
    // console.log(`✅ Created ${transactionData.length} transactions`);

    // ═══════════════════════════════════════════════════════════════
    // CREATE PROFIT STATISTICS (Last 30 days)
    // ═══════════════════════════════════════════════════════════════

    console.log('📊 Creating profit statistics...');

    const profitData = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Generate profit data for the last 30 days
    for (let i = 29; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);

        // Define day boundaries
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);

        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);

        // Filter transactions for this specific day
        const dayTransactions = transactionData.filter(t => {
            const tDate = new Date(t.createdAt);
            return tDate >= dayStart && tDate <= dayEnd;
        });

        // Calculate totals by type
        const deposits = dayTransactions
            .filter(t => t.type === 'DEPOSIT' && t.status === 'COMPLETED')
            .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

        const withdrawals = dayTransactions
            .filter(t => t.type === 'WITHDRAWAL' && t.status === 'COMPLETED')
            .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

        const wins = dayTransactions
            .filter(t => t.type === 'WIN')
            .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

        const losses = dayTransactions
            .filter(t => t.type === 'LOSS')
            .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

        // Calculate profit: (Deposits + Losses) - (Withdrawals + Wins)
        const profit = (deposits + losses) - (withdrawals + wins);

        profitData.push({
            date: date,
            profit: new Prisma.Decimal(profit.toFixed(2))
        });
    }

    // Bulk insert profit data
    if (profitData.length > 0) {
        await prisma.profitStat.createMany({
            data: profitData
        });
        console.log(`✅ Created ${profitData.length} profit statistics`);
    }

    // ═══════════════════════════════════
    // CREATE BONUSES
    // ═══════════════════════════════════

    console.log('🎁 Creating bonuses...');
    const bonusData = [];
    const bonusTypes = ['WELCOME', 'DEPOSIT_MATCH', 'LOYALTY', 'FREEPLAY_DAILY', 'FREEPLAY_WEEKLY', 'SPIN_THE_WHEEL', 'ATTENDANCE', 'BIRTHDAY'];

    for (const user of users) {
        for (let i = 0; i < getRandomNumber(2, 5); i++) {
            bonusData.push({
                userId: user.id,
                type: bonusTypes[getRandomNumber(0, bonusTypes.length - 1)],
                amount: new Prisma.Decimal(getRandomDecimal(5, 200).toString()),
                description: `bonus`,
                claimed: Math.random() > 0.3,
                claimedAt: Math.random() > 0.5 ? getRandomDateInLastDays(30) : null,
                expiresAt: new Date(Date.now() + getRandomNumber(10, 90) * 24 * 60 * 60 * 1000),
                wagerRequired: new Prisma.Decimal(getRandomNumber(100, 1000).toString()),
                wagerMet: new Prisma.Decimal(getRandomNumber(0, 800).toString())
            });
        }
    }

    for (let i = 0; i < bonusData.length; i += batchSize) {
        const batch = bonusData.slice(i, i + batchSize);
        await prisma.bonus.createMany({
            data: batch
        });
    }
    console.log(`✅ Created ${bonusData.length} bonuses`);

    // ═══════════════════════════════════
    // CREATE ATTENDANCE RECORDS
    // ═══════════════════════════════════

    console.log('📅 Creating attendance records...');
    const attendanceData = [];
    const attendanceToday = new Date();

    for (const user of users) {
        const startStreak = getRandomNumber(1, 10);
        for (let i = 0; i < getRandomNumber(5, 15); i++) {
            const date = new Date(attendanceToday);
            date.setDate(date.getDate() - i);
            date.setHours(0, 0, 0, 0);

            attendanceData.push({
                userId: user.id,
                date,
                streak: Math.max(1, startStreak - i),
                rewardClaimed: Math.random() > 0.2,
                rewardAmount: new Prisma.Decimal(getRandomDecimal(1, 10).toString())
            });
        }
    }

    for (let i = 0; i < attendanceData.length; i += batchSize) {
        const batch = attendanceData.slice(i, i + batchSize);
        await prisma.attendance.createMany({
            data: batch,
            skipDuplicates: true
        });
    }
    console.log(`✅ Created attendance records`);

    // ═══════════════════════════════════
    // CREATE ISSUES RECORDS (UPDATED)
    // ═══════════════════════════════════

    console.log('🎯 Creating issues records...');
    const issuesData = [];
    const issueStatuses = ['UNRESOLVED', 'RESOLVED'];
    const issuePriorities = ['LOW', 'MEDIUM', 'HIGH'];

    // Create 2-4 issues per user with proper schema
    for (const user of users) {
        const numIssues = getRandomNumber(2, 4);

        for (let i = 0; i < numIssues; i++) {
            const template = issueTemplates[getRandomNumber(0, issueTemplates.length - 1)];
            const status = issueStatuses[getRandomNumber(0, issueStatuses.length - 1)];

            issuesData.push({
                title: template.title,
                description: template.description,
                playerName: user.name,
                status: status,
                priority: issuePriorities[getRandomNumber(0, issuePriorities.length - 1)],
                createdAt: getRandomDateInLastDays(30),
                updatedAt: getRandomDateInLastDays(30)
            });
        }
    }

    // Bulk insert issues
    for (let i = 0; i < issuesData.length; i += batchSize) {
        const batch = issuesData.slice(i, i + batchSize);
        await prisma.issue.createMany({
            data: batch
        });
    }
    console.log(`✅ Created ${issuesData.length} issues records`);

    // ═══════════════════════════════════
    // CREATE NOTIFICATIONS
    // ═══════════════════════════════════

    console.log('🔔 Creating notifications...');
    const notificationData = [];
    const notificationTypes = ['TRANSACTION', 'BONUS', 'PROMOTION', 'SYSTEM', 'SECURITY'];

    for (const user of users) {
        for (let i = 0; i < getRandomNumber(2, 5); i++) {
            notificationData.push({
                userId: user.id,
                type: notificationTypes[getRandomNumber(0, notificationTypes.length - 1)],
                title: ['Bonus Available', 'Deposit Confirmed', 'Promotion Alert', 'Security Update'][getRandomNumber(0, 3)],
                message: 'You have a new notification',
                read: Math.random() > 0.4,
                createdAt: getRandomDateInLastDays(7)
            });
        }
    }

    for (let i = 0; i < notificationData.length; i += batchSize) {
        const batch = notificationData.slice(i, i + batchSize);
        await prisma.notification.createMany({
            data: batch
        });
    }
    console.log(`✅ Created ${notificationData.length} notifications`);

    // ═══════════════════════════════════
    // CREATE SYSTEM SETTINGS
    // ═══════════════════════════════════

    console.log('⚙️  Creating system settings...');
    await prisma.systemSetting.createMany({
        data: [
            { key: 'site_name', value: 'OceanBets', category: 'general' },
            { key: 'maintenance_mode', value: 'false', category: 'general' },
            { key: 'registration_enabled', value: 'true', category: 'general' },
            { key: 'default_bonus_percentage', value: '50', category: 'bonuses' },
            { key: 'referral_bonus', value: '100', category: 'bonuses' },
            { key: 'welcome_bonus', value: '100', category: 'bonuses' },
            { key: 'min_deposit', value: '10', category: 'limits' },
            { key: 'max_deposit', value: '10000', category: 'limits' },
            { key: 'min_withdrawal', value: '20', category: 'limits' },
            { key: 'max_withdrawal', value: '5000', category: 'limits' },
            { key: 'session_timeout', value: '7200', category: 'security' },
            { key: 'max_login_attempts', value: '5', category: 'security' },
            { key: 'require_email_verification', value: 'true', category: 'security' },
            { key: '2fa_enabled', value: 'true', category: 'security' },
            { key: 'smtp_host', value: 'smtp.gmail.com', category: 'email' },
            { key: 'smtp_port', value: '587', category: 'email' },
            { key: 'from_email', value: 'noreply@oceanbets.com', category: 'email' },
            { key: 'attendance_enabled', value: 'true', category: 'features' },
            { key: 'spin_wheel_enabled', value: 'true', category: 'features' },
            { key: 'referral_enabled', value: 'true', category: 'features' }
        ]
    });

    // ═══════════════════════════════════
    // GENERATE ANALYTICS DATA
    // ═══════════════════════════════════

    console.log('📊 Generating analytics data...');
    const analyticsData = generateAnalyticsData(transactionData, users);

    // ═══════════════════════════════════
    // PRINT SUMMARY
    // ═══════════════════════════════════

    console.log('\n✅ Database seeded successfully!\n');
    printSeededData(users, transactionData, issuesData, analyticsData);


    // ═══════════════════════════════════════════════════════════════
    // ANALYTICS GENERATION
    // ═══════════════════════════════════════════════════════════════

    function generateAnalyticsData(transactions, users, games) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const depositData = generateDepositData(transactions, today);
        const topDepositors = generateTopDepositors(transactions);
        const topCashouts = generateTopCashouts(transactions);
        // const topGamesByDeposits = generateTopGamesByDeposits(games, transactions);
        // const topGamesByCashouts = generateTopGamesByCashouts(games, transactions);
        const profitData = generateProfitData(transactions, today);

        return {
            depositData,
            topDepositors,
            topCashouts,
            // topGamesByDeposits,
            // topGamesByCashouts,
            profitData
        };
    }

    function generateDepositData(transactions, today) {
        const deposits = transactions.filter(t => t.type === 'DEPOSIT' && t.status === 'COMPLETED');

        const last30Days = deposits.filter(t => {
            const diff = Math.floor((today - t.createdAt) / (1000 * 60 * 60 * 24));
            return diff <= 30;
        });

        const last7Days = deposits.filter(t => {
            const diff = Math.floor((today - t.createdAt) / (1000 * 60 * 60 * 24));
            return diff <= 7;
        });

        const todayDeposits = deposits.filter(t => {
            const diff = Math.floor((today - t.createdAt) / (1000 * 60 * 60 * 24));
            return diff === 0;
        });

        const sum30Days = last30Days.reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);
        const sum7Days = last7Days.reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);
        const sumToday = todayDeposits.reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

        return {
            period_30days: {
                totalCount: last30Days.length,
                totalAmount: sum30Days.toFixed(2),
                averageAmount: (sum30Days / last30Days.length).toFixed(2),
                uniqueUsers: new Set(last30Days.map(t => t.userId)).size
            },
            period_7days: {
                totalCount: last7Days.length,
                totalAmount: sum7Days.toFixed(2),
                averageAmount: (sum7Days / last7Days.length).toFixed(2),
                uniqueUsers: new Set(last7Days.map(t => t.userId)).size
            },
            today: {
                totalCount: todayDeposits.length,
                totalAmount: sumToday.toFixed(2),
                averageAmount: todayDeposits.length > 0 ? (sumToday / todayDeposits.length).toFixed(2) : '0.00',
                uniqueUsers: new Set(todayDeposits.map(t => t.userId)).size
            }
        };
    }

    function generateTopDepositors(transactions) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const getDepositorsByPeriod = (days) => {
            const deposits = transactions.filter(t => {
                const diff = Math.floor((today - t.createdAt) / (1000 * 60 * 60 * 24));
                return t.type === 'DEPOSIT' && t.status === 'COMPLETED' && diff <= days;
            });

            const userTotals = {};
            deposits.forEach(t => {
                const userId = t.userId;
                const amount = parseFloat(t.amount.toString());
                userTotals[userId] = (userTotals[userId] || 0) + amount;
            });

            return Object.entries(userTotals)
                .map(([userId, total]) => ({
                    userId: parseInt(userId),
                    totalDeposits: parseFloat(total.toFixed(2)),
                    count: deposits.filter(t => t.userId === parseInt(userId)).length
                }))
                .sort((a, b) => b.totalDeposits - a.totalDeposits)
                .slice(0, 10);
        };

        return {
            period_1day: getDepositorsByPeriod(1),
            period_7days: getDepositorsByPeriod(7),
            period_30days: getDepositorsByPeriod(30)
        };
    }

    function generateTopCashouts(transactions) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const getCashoutsByPeriod = (days) => {
            const cashouts = transactions.filter(t => {
                const diff = Math.floor((today - t.createdAt) / (1000 * 60 * 60 * 24));
                return t.type === 'WITHDRAWAL' && t.status === 'COMPLETED' && diff <= days;
            });

            const userTotals = {};
            cashouts.forEach(t => {
                const userId = t.userId;
                const amount = parseFloat(t.amount.toString());
                userTotals[userId] = (userTotals[userId] || 0) + amount;
            });

            return Object.entries(userTotals)
                .map(([userId, total]) => ({
                    userId: parseInt(userId),
                    totalCashouts: parseFloat(total.toFixed(2)),
                    count: cashouts.filter(t => t.userId === parseInt(userId)).length
                }))
                .sort((a, b) => b.totalCashouts - a.totalCashouts)
                .slice(0, 10);
        };

        return {
            period_1day: getCashoutsByPeriod(1),
            period_7days: getCashoutsByPeriod(7),
            period_30days: getCashoutsByPeriod(30)
        };
    }

    // function generateTopGamesByDeposits(games, transactions) {
    //     const getGamesByPeriod = (days) => {
    //         const gameStats = {};

    //         games.forEach(game => {
    //             gameStats[game.gameId] = {
    //                 gameId: game.gameId,
    //                 gameName: game.gameName,
    //                 totalDeposits: getRandomDecimal(100, 10000),
    //                 playerCount: getRandomNumber(5, 500),
    //                 avgStake: getRandomDecimal(1, 100)
    //             };
    //         });

    //         return Object.values(gameStats)
    //             .sort((a, b) => b.totalDeposits - a.totalDeposits)
    //             .slice(0, 10);
    //     };

    //     return {
    //         period_1day: getGamesByPeriod(1),
    //         period_7days: getGamesByPeriod(7),
    //         period_30days: getGamesByPeriod(30)
    //     };
    // }

    // function generateTopGamesByCashouts(games, transactions) {
    //     const getGamesByPeriod = (days) => {
    //         const gameStats = {};

    //         games.forEach(game => {
    //             gameStats[game.gameId] = {
    //                 gameId: game.gameId,
    //                 gameName: game.gameName,
    //                 totalCashouts: getRandomDecimal(50, 8000),
    //                 playerCount: getRandomNumber(5, 500),
    //                 avgWin: getRandomDecimal(1, 200)
    //             };
    //         });

    //         return Object.values(gameStats)
    //             .sort((a, b) => b.totalCashouts - a.totalCashouts)
    //             .slice(0, 10);
    //     };

    //     return {
    //         period_1day: getGamesByPeriod(1),
    //         period_7days: getGamesByPeriod(7),
    //         period_30days: getGamesByPeriod(30)
    //     };
    // }

    function generateProfitData(transactions, today) {
        const generateDailyProfitData = (days) => {
            const dailyData = [];

            for (let i = days - 1; i >= 0; i--) {
                const date = new Date(today);
                date.setDate(date.getDate() - i);

                const dayTransactions = transactions.filter(t => {
                    const diff = Math.floor((date - t.createdAt) / (1000 * 60 * 60 * 24));
                    return diff === 0;
                });

                const deposits = dayTransactions
                    .filter(t => t.type === 'DEPOSIT' && t.status === 'COMPLETED')
                    .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

                const withdrawals = dayTransactions
                    .filter(t => t.type === 'WITHDRAWAL' && t.status === 'COMPLETED')
                    .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

                const wins = dayTransactions
                    .filter(t => t.type === 'WIN')
                    .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

                const losses = dayTransactions
                    .filter(t => t.type === 'LOSS')
                    .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

                const profit = (deposits + losses) - (withdrawals + wins);

                dailyData.push({
                    date: date.toISOString().split('T')[0],
                    deposits: parseFloat(deposits.toFixed(2)),
                    withdrawals: parseFloat(withdrawals.toFixed(2)),
                    wins: parseFloat(wins.toFixed(2)),
                    losses: parseFloat(losses.toFixed(2)),
                    profit: parseFloat(profit.toFixed(2)),
                    transactionCount: dayTransactions.length
                });
            }

            return dailyData;
        };

        return {
            period_7days: generateDailyProfitData(7),
            period_30days: generateDailyProfitData(30)
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // PRINT SUMMARY
    // ═══════════════════════════════════════════════════════════════

    function printSeededData(users, transactions, issues, analyticsData) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📝 ADMIN ACCOUNTS:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Super Admin:');
        console.log('  Username: superadmin');
        console.log('  Password: admin123\n');
        console.log('Admin:');
        console.log('  Username: admin');
        console.log('  Password: admin123\n');

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 SEEDING SUMMARY:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`👥 Total Users: ${users.length}`);
        console.log(`💰 Total Transactions: ${transactions.length}`);
        console.log(`🎯 Total Issues: ${issues.length}`);
        console.log(`📈 Profit Data Points: 30 (1 per day)`);
        console.log(`📊 Average Issues per User: ${(issues.length / users.length).toFixed(2)}`);

        console.log('\n✅ All data generated successfully!');
    }
}

main()
    .catch((e) => {
        console.error('❌ Seeding failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });