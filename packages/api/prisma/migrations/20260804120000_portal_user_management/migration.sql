-- Portal user management.
--
-- Before this, the only code that created a PortalUser was the seed
-- script: provisioning a tenant produced a company nobody could log
-- into, and there was no way to disable an account or rotate a password.

ALTER TABLE "portal_users" ADD COLUMN "displayName" TEXT;
ALTER TABLE "portal_users" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "portal_users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "portal_users" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
ALTER TABLE "portal_users" ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- Only the hash is stored; the plaintext is shown once at creation.
-- Cascade on delete: a reset token for a removed user is meaningless,
-- and leaving one behind would block the delete for no reason.
CREATE TABLE "password_reset_tokens" (
  "tokenId"   TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("tokenId")
);

CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "portal_users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
