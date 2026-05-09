-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PLAYER', 'ADMIN', 'TEAM1', 'TEAM2', 'TEAM3', 'TEAM4', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'CRITICAL', 'HIGHLY_CRITICAL', 'INACTIVE', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "TierLevel" AS ENUM ('BRONZE', 'SILVER', 'GOLD');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'BONUS', 'FREEPLAY', 'REFERRAL', 'ADJUSTMENT', 'WIN', 'LOSS', 'ATTENDANCE');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'PROCESSING');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PAYPAL', 'STRIPE', 'CRYPTO', 'UPI', 'BANK_TRANSFER', 'WALLET');

-- CreateEnum
CREATE TYPE "BonusType" AS ENUM ('WELCOME', 'DEPOSIT_MATCH', 'CASHBACK', 'LOYALTY', 'REFERRAL', 'FREEPLAY_DAILY', 'FREEPLAY_WEEKLY', 'SPIN_THE_WHEEL', 'ATTENDANCE', 'BIRTHDAY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('UNRESOLVED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('STANDARD', 'DAILY_CHECKLIST', 'PLAYER_ADDITION', 'REVENUE_TARGET', 'MISSING_INFO', 'PLAYER_FOLLOWUP', 'BONUS_FOLLOWUP');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShiftFormStatus" AS ENUM ('PENDING', 'BALANCE_CONFIRMED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('POINT_RELOAD', 'SERVICE_FEE', 'OTHER');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('HEALTHY', 'LOW_STOCK', 'DEFICIT');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TRANSACTION', 'BONUS', 'PROMOTION', 'SYSTEM', 'SECURITY');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('LOGIN', 'LOGOUT', 'DEPOSIT', 'WITHDRAWAL', 'BONUS_CLAIMED', 'USER_CREATED', 'USER_UPDATED', 'USER_SUSPENDED', 'TRANSACTION_APPROVED', 'TRANSACTION_REJECTED', 'TIER_UPGRADED', 'SETTINGS_CHANGED', 'PASSWORD_CHANGED', 'TWO_FA_ENABLED', 'TWO_FA_DISABLED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "storeAccess" INTEGER[] DEFAULT ARRAY[1]::INTEGER[],
    "username" TEXT NOT NULL,
    "password" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'PLAYER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tier" "TierLevel" NOT NULL DEFAULT 'BRONZE',
    "tierPoints" INTEGER NOT NULL DEFAULT 0,
    "weeklyDeposit" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalWagered" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalWon" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "winStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "referralCode" TEXT NOT NULL,
    "referredBy" INTEGER,
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "facebook" TEXT,
    "telegram" TEXT,
    "instagram" TEXT,
    "twitterX" TEXT,
    "snapchat" TEXT,
    "chimeTag" TEXT,
    "cashappTag" TEXT,
    "paypalEmail" TEXT,
    "source" TEXT,
    "cashoutLimit" DECIMAL(10,2) NOT NULL DEFAULT 250,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "lastPlayedDate" TIMESTAMP(3),
    "playTimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "assignedToId" INTEGER,
    "noAccountOn" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_edit_requests" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "playerId" INTEGER NOT NULL,
    "requestedBy" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedBy" INTEGER,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_edit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TierConfig" (
    "id" SERIAL NOT NULL,
    "tier" "TierLevel" NOT NULL,
    "minDeposit" DECIMAL(10,2) NOT NULL,
    "maxDeposit" DECIMAL(10,2) NOT NULL,
    "dailyCashoutLimit" DECIMAL(10,2) NOT NULL,
    "weeklyCashoutLimit" DECIMAL(10,2) NOT NULL,
    "bonusMultiplier" DECIMAL(3,2) NOT NULL,
    "freeplayDaily" DECIMAL(10,2) NOT NULL,
    "freeplayWeekly" DECIMAL(10,2) NOT NULL,
    "pointsRequired" INTEGER NOT NULL,
    "benefits" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TierConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "bonus" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paymentMethod" "PaymentMethod",
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "gameId" TEXT,
    "paymentId" TEXT,
    "paymentGateway" TEXT,
    "description" TEXT,
    "notes" TEXT,
    "ipAddress" TEXT,
    "approvedBy" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfitStat" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profit" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfitStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bonus" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "BonusType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "description" TEXT NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "wagerRequired" DECIMAL(10,2),
    "wagerMet" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bonus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "streak" INTEGER NOT NULL DEFAULT 1,
    "rewardClaimed" BOOLEAN NOT NULL DEFAULT false,
    "rewardAmount" DECIMAL(10,2),

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "playerName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "Status" NOT NULL DEFAULT 'UNRESOLVED',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',

    CONSTRAINT "issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "teamName" TEXT NOT NULL,
    "isShiftActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" SERIAL NOT NULL,
    "teamId" INTEGER NOT NULL,
    "teamRole" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "duration" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftCheckin" (
    "id" SERIAL NOT NULL,
    "shiftId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "confirmedBalance" DOUBLE PRECISION,
    "balanceConfirmedAt" TIMESTAMP(3),
    "balanceNote" TEXT,
    "effortRating" INTEGER,
    "workSummary" TEXT,
    "issuesEncountered" TEXT,
    "shoutouts" TEXT,
    "additionalNotes" TEXT,
    "endFormSubmittedAt" TIMESTAMP(3),
    "status" "ShiftFormStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftCheckin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_ratings" (
    "id" SERIAL NOT NULL,
    "shiftId" INTEGER NOT NULL,
    "ratedById" INTEGER NOT NULL,
    "memberId" INTEGER NOT NULL,
    "teamRole" TEXT NOT NULL,
    "communicationWithPlayer" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loadReloadSmoothness" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "liveReportingToPlayers" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "playtimeBonus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "referralBonus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "matchAndRandomBonus" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "playerEngagementOverall" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reachingOutInShifts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reachingOutFromOwnList" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cashoutTiming" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overallRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recommendations" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "gameId" TEXT,
    "details" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL DEFAULT 'POINT_RELOAD',
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pointsAdded" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "paymentMade" DOUBLE PRECISION,
    "walletId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" TEXT NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "iconUrl" TEXT,
    "pointStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "GameStatus" NOT NULL DEFAULT 'HEALTHY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isShared" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_store_stocks" (
    "id" SERIAL NOT NULL,
    "gameId" TEXT NOT NULL,
    "storeId" INTEGER NOT NULL,
    "pointStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "GameStatus" NOT NULL DEFAULT 'HEALTHY',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_store_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "identifier" TEXT,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isLive" BOOLEAN NOT NULL DEFAULT true,
    "isShared" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_store_balances" (
    "id" SERIAL NOT NULL,
    "walletId" INTEGER NOT NULL,
    "storeId" INTEGER NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_store_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streak_freezes" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "freezeUntil" TIMESTAMP(3) NOT NULL,
    "frozenById" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "streak_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "taskType" "TaskType" NOT NULL DEFAULT 'STANDARD',
    "targetValue" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "assignToAll" BOOLEAN NOT NULL DEFAULT false,
    "checklistItems" JSONB,
    "isDaily" BOOLEAN NOT NULL DEFAULT false,
    "dailyResetAt" TIMESTAMP(3),
    "createdById" INTEGER NOT NULL,
    "assignedToId" INTEGER,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubTask" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER NOT NULL,
    "assignedToId" INTEGER,
    "label" TEXT NOT NULL,
    "targetValue" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskProgressLog" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskProgressLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_bonuses" (
    "id" SERIAL NOT NULL,
    "referrerId" INTEGER NOT NULL,
    "referredId" INTEGER NOT NULL,
    "depositAmount" DECIMAL(10,2) NOT NULL,
    "bonusAmount" DECIMAL(10,2) NOT NULL,
    "referrerClaimed" BOOLEAN NOT NULL DEFAULT false,
    "referrerClaimedAt" TIMESTAMP(3),
    "referrerTxId" INTEGER,
    "referredClaimed" BOOLEAN NOT NULL DEFAULT false,
    "referredClaimedAt" TIMESTAMP(3),
    "referredTxId" INTEGER,
    "triggerDepositId" INTEGER,
    "gameId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_milestone_bonuses" (
    "id" SERIAL NOT NULL,
    "playerId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "milestone" INTEGER NOT NULL,
    "bonusAmount" DECIMAL(10,2) NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),
    "gameId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_milestone_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_weekly_bonuses" (
    "id" SERIAL NOT NULL,
    "referrerId" INTEGER NOT NULL,
    "referredId" INTEGER NOT NULL,
    "weekOf" TEXT NOT NULL,
    "totalDeposits" DECIMAL(10,2) NOT NULL,
    "bonusAmount" DECIMAL(10,2) NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),
    "gameId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_weekly_bonuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profit_takeouts" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "amount" DECIMAL(10,2) NOT NULL,
    "takenBy" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'Cash',
    "walletId" INTEGER,
    "notes" TEXT,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profit_takeouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_reconciliation_snapshots" (
    "id" SERIAL NOT NULL,
    "shiftId" INTEGER NOT NULL,
    "storeId" INTEGER NOT NULL DEFAULT 1,
    "startWalletTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startGameTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startCapturedAt" TIMESTAMP(3),
    "startRawJson" JSONB,
    "endWalletTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "endGameTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "endCapturedAt" TIMESTAMP(3),
    "endRawJson" JSONB,
    "actualWalletChange" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualGameChange" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expectedWalletChange" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expectedGameChange" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "walletDiscrepancy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gameDiscrepancy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isBalanced" BOOLEAN NOT NULL DEFAULT false,
    "crossStoreGamePts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "crossStoreWalletAmt" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "crossAdjBalanced" BOOLEAN NOT NULL DEFAULT false,
    "deposits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completedCashouts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pendingCashouts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bonuses" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "depositFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cashoutFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expenseWalletPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pointsReloaded" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "takeoutWalletPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_reconciliation_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletBalanceLog" (
    "id" SERIAL NOT NULL,
    "walletId" INTEGER NOT NULL,
    "storeId" INTEGER NOT NULL,
    "changeAmount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "editedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletBalanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameStockLog" (
    "id" SERIAL NOT NULL,
    "gameId" TEXT NOT NULL,
    "storeId" INTEGER NOT NULL,
    "changeAmount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "editedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameStockLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "actionUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT,
    "lastActive" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "activityType" "ActivityType" NOT NULL,
    "description" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailQueue" (
    "id" SERIAL NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" SERIAL NOT NULL,
    "identifier" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_Friends" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_role_storeId_idx" ON "User"("role", "storeId");

-- CreateIndex
CREATE INDEX "User_storeId_status_idx" ON "User"("storeId", "status");

-- CreateIndex
CREATE INDEX "User_role_storeAccess_idx" ON "User"("role", "storeAccess");

-- CreateIndex
CREATE INDEX "User_storeId_idx" ON "User"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "User_storeId_username_key" ON "User"("storeId", "username");

-- CreateIndex
CREATE INDEX "player_edit_requests_storeId_status_idx" ON "player_edit_requests"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TierConfig_tier_key" ON "TierConfig"("tier");

-- CreateIndex
CREATE INDEX "Transaction_userId_createdAt_idx" ON "Transaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_status_createdAt_idx" ON "Transaction"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_storeId_createdAt_idx" ON "Transaction"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "ProfitStat_storeId_idx" ON "ProfitStat"("storeId");

-- CreateIndex
CREATE INDEX "Bonus_userId_claimed_idx" ON "Bonus"("userId", "claimed");

-- CreateIndex
CREATE INDEX "Attendance_userId_date_idx" ON "Attendance"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_userId_date_key" ON "Attendance"("userId", "date");

-- CreateIndex
CREATE INDEX "issue_storeId_idx" ON "issue"("storeId");

-- CreateIndex
CREATE INDEX "Team_storeId_idx" ON "Team"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftCheckin_shiftId_key" ON "ShiftCheckin"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "shift_ratings_shiftId_key" ON "shift_ratings"("shiftId");

-- CreateIndex
CREATE INDEX "shift_ratings_memberId_idx" ON "shift_ratings"("memberId");

-- CreateIndex
CREATE INDEX "expenses_storeId_idx" ON "expenses"("storeId");

-- CreateIndex
CREATE INDEX "games_storeId_idx" ON "games"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "games_storeId_name_key" ON "games"("storeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "games_storeId_slug_key" ON "games"("storeId", "slug");

-- CreateIndex
CREATE INDEX "game_store_stocks_storeId_idx" ON "game_store_stocks"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "game_store_stocks_gameId_storeId_key" ON "game_store_stocks"("gameId", "storeId");

-- CreateIndex
CREATE INDEX "wallets_storeId_idx" ON "wallets"("storeId");

-- CreateIndex
CREATE INDEX "wallet_store_balances_storeId_idx" ON "wallet_store_balances"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_store_balances_walletId_storeId_key" ON "wallet_store_balances"("walletId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "streak_freezes_userId_key" ON "streak_freezes"("userId");

-- CreateIndex
CREATE INDEX "Task_storeId_idx" ON "Task"("storeId");

-- CreateIndex
CREATE INDEX "referral_bonuses_referrerId_referrerClaimed_idx" ON "referral_bonuses"("referrerId", "referrerClaimed");

-- CreateIndex
CREATE INDEX "referral_bonuses_referredId_referredClaimed_idx" ON "referral_bonuses"("referredId", "referredClaimed");

-- CreateIndex
CREATE INDEX "deposit_milestone_bonuses_playerId_claimed_idx" ON "deposit_milestone_bonuses"("playerId", "claimed");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_milestone_bonuses_playerId_date_milestone_key" ON "deposit_milestone_bonuses"("playerId", "date", "milestone");

-- CreateIndex
CREATE INDEX "referral_weekly_bonuses_referrerId_claimed_idx" ON "referral_weekly_bonuses"("referrerId", "claimed");

-- CreateIndex
CREATE UNIQUE INDEX "referral_weekly_bonuses_referrerId_referredId_weekOf_key" ON "referral_weekly_bonuses"("referrerId", "referredId", "weekOf");

-- CreateIndex
CREATE INDEX "profit_takeouts_storeId_idx" ON "profit_takeouts"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "shift_reconciliation_snapshots_shiftId_key" ON "shift_reconciliation_snapshots"("shiftId");

-- CreateIndex
CREATE INDEX "shift_reconciliation_snapshots_storeId_idx" ON "shift_reconciliation_snapshots"("storeId");

-- CreateIndex
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_createdAt_idx" ON "ActivityLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_activityType_createdAt_idx" ON "ActivityLog"("activityType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- CreateIndex
CREATE INDEX "EmailQueue_status_createdAt_idx" ON "EmailQueue"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RateLimit_resetAt_idx" ON "RateLimit"("resetAt");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimit_identifier_endpoint_key" ON "RateLimit"("identifier", "endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "_Friends_AB_unique" ON "_Friends"("A", "B");

-- CreateIndex
CREATE INDEX "_Friends_B_index" ON "_Friends"("B");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredBy_fkey" FOREIGN KEY ("referredBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_edit_requests" ADD CONSTRAINT "player_edit_requests_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_edit_requests" ADD CONSTRAINT "player_edit_requests_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_edit_requests" ADD CONSTRAINT "player_edit_requests_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bonus" ADD CONSTRAINT "Bonus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftCheckin" ADD CONSTRAINT "ShiftCheckin_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftCheckin" ADD CONSTRAINT "ShiftCheckin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_store_stocks" ADD CONSTRAINT "game_store_stocks_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_store_balances" ADD CONSTRAINT "wallet_store_balances_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streak_freezes" ADD CONSTRAINT "streak_freezes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubTask" ADD CONSTRAINT "SubTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubTask" ADD CONSTRAINT "SubTask_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskProgressLog" ADD CONSTRAINT "TaskProgressLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskProgressLog" ADD CONSTRAINT "TaskProgressLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_bonuses" ADD CONSTRAINT "referral_bonuses_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_bonuses" ADD CONSTRAINT "referral_bonuses_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_milestone_bonuses" ADD CONSTRAINT "deposit_milestone_bonuses_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_weekly_bonuses" ADD CONSTRAINT "referral_weekly_bonuses_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_weekly_bonuses" ADD CONSTRAINT "referral_weekly_bonuses_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletBalanceLog" ADD CONSTRAINT "WalletBalanceLog_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletBalanceLog" ADD CONSTRAINT "WalletBalanceLog_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameStockLog" ADD CONSTRAINT "GameStockLog_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameStockLog" ADD CONSTRAINT "GameStockLog_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_Friends" ADD CONSTRAINT "_Friends_A_fkey" FOREIGN KEY ("A") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_Friends" ADD CONSTRAINT "_Friends_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
