-- CreateEnum
CREATE TYPE "CampaignAudience" AS ENUM ('NEW_USERS', 'ALL_USERS');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- AlterTable
ALTER TABLE "token_ledger" ADD COLUMN     "campaignId" UUID;

-- CreateTable
CREATE TABLE "token_campaigns" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "tokens" INTEGER NOT NULL,
    "audience" "CampaignAudience" NOT NULL DEFAULT 'NEW_USERS',
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "maxGrants" INTEGER,
    "grantsIssued" INTEGER NOT NULL DEFAULT 0,
    "requiresVerifiedEmail" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_grants" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokens" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "token_campaigns_status_idx" ON "token_campaigns"("status");

-- CreateIndex
CREATE INDEX "token_grants_userId_createdAt_idx" ON "token_grants"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "token_grants_campaignId_userId_key" ON "token_grants"("campaignId", "userId");

-- AddForeignKey
ALTER TABLE "token_campaigns" ADD CONSTRAINT "token_campaigns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_grants" ADD CONSTRAINT "token_grants_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "token_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_grants" ADD CONSTRAINT "token_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
