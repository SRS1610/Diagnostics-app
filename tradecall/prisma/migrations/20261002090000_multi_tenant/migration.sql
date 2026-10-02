-- Multi-tenant: logins move from Business to User (many per business, with
-- roles), plus invites, an audit log, tenant status/plan and per-tenant
-- messaging profiles. Existing data is preserved: each business's current
-- login becomes that business's OWNER user BEFORE the old column is dropped.

CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "Plan" AS ENUM ('STARTER', 'PRO', 'TEAM');
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'PLATFORM_ADMIN');
CREATE TYPE "ActorKind" AS ENUM ('USER', 'PLATFORM', 'SYSTEM');

ALTER TABLE "Business"
  ADD COLUMN "messagingProfileId" TEXT,
  ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'STARTER',
  ADD COLUMN "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "suspendedReason" TEXT;

ALTER TABLE "Message" ADD COLUMN "sentBy" TEXT;

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "phone" TEXT,
    "getsAlerts" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
    -- Platform admins belong to no tenant; everyone else to exactly one.
    CONSTRAINT "User_tenant_matches_role" CHECK (("role" = 'PLATFORM_ADMIN') = ("businessId" IS NULL))
);

CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Invite_role_not_platform" CHECK ("role" <> 'PLATFORM_ADMIN')
);

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "actorKind" "ActorKind" NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- Carry every existing login over as its business's OWNER.
INSERT INTO "User" ("id", "businessId", "email", "passwordHash", "name", "role", "phone", "getsAlerts", "active", "createdAt", "updatedAt")
SELECT 'mig_' || "id", "id", lower("email"), "passwordHash", "ownerName", 'OWNER', "ownerPhone", true, true, "createdAt", CURRENT_TIMESTAMP
FROM "Business";

DROP INDEX "Business_email_key";
ALTER TABLE "Business" DROP COLUMN "passwordHash";

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_businessId_idx" ON "User"("businessId");
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");
CREATE INDEX "Invite_businessId_idx" ON "Invite"("businessId");
CREATE INDEX "AuditLog_businessId_createdAt_idx" ON "AuditLog"("businessId", "createdAt");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "Business_status_idx" ON "Business"("status");

ALTER TABLE "User" ADD CONSTRAINT "User_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
