-- CreateEnum
CREATE TYPE "TokenLedgerKind" AS ENUM ('PURCHASE', 'TIP_SENT', 'TIP_RECEIVED', 'REFUND', 'ADJUSTMENT', 'PROMO');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED');

-- CreateTable
CREATE TABLE "token_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarned" INTEGER NOT NULL DEFAULT 0,
    "lifetimePurchased" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_ledger" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "kind" "TokenLedgerKind" NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "counterpartyId" UUID,
    "matchId" UUID,
    "purchaseId" UUID,
    "tipId" UUID,
    "note" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_packages" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_purchases" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'STRIPE',
    "providerRef" TEXT,
    "providerEventId" TEXT,
    "tokens" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tips" (
    "id" UUID NOT NULL,
    "matchId" UUID,
    "fromUserId" UUID NOT NULL,
    "toUserId" UUID NOT NULL,
    "tokens" INTEGER NOT NULL,
    "message" VARCHAR(200),
    "offeredSeconds" INTEGER,
    "accepted" BOOLEAN,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "token_accounts_userId_key" ON "token_accounts"("userId");

-- CreateIndex
CREATE INDEX "token_ledger_userId_createdAt_idx" ON "token_ledger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "token_ledger_kind_idx" ON "token_ledger"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "token_packages_slug_key" ON "token_packages"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "token_purchases_providerRef_key" ON "token_purchases"("providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "token_purchases_providerEventId_key" ON "token_purchases"("providerEventId");

-- CreateIndex
CREATE INDEX "token_purchases_userId_createdAt_idx" ON "token_purchases"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "token_purchases_status_idx" ON "token_purchases"("status");

-- CreateIndex
CREATE INDEX "tips_toUserId_createdAt_idx" ON "tips"("toUserId", "createdAt");

-- CreateIndex
CREATE INDEX "tips_fromUserId_createdAt_idx" ON "tips"("fromUserId", "createdAt");

-- CreateIndex
CREATE INDEX "tips_matchId_idx" ON "tips"("matchId");

-- AddForeignKey
ALTER TABLE "token_accounts" ADD CONSTRAINT "token_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_purchases" ADD CONSTRAINT "token_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_purchases" ADD CONSTRAINT "token_purchases_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "token_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tips" ADD CONSTRAINT "tips_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tips" ADD CONSTRAINT "tips_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
