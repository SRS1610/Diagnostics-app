-- TOTP MFA on PortalUser
ALTER TABLE "portal_users" ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "portal_users" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "portal_users" ADD COLUMN "mfaEnrolledAt" TIMESTAMP(3);

CREATE TABLE "mfa_backup_codes" (
  "codeId"    TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "codeHash"  TEXT NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_backup_codes_pkey" PRIMARY KEY ("codeId")
);
CREATE INDEX "mfa_backup_codes_userId_idx" ON "mfa_backup_codes"("userId");
ALTER TABLE "mfa_backup_codes" ADD CONSTRAINT "mfa_backup_codes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "portal_users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- API keys: tenant-scoped, read-only programmatic access
CREATE TABLE "api_keys" (
  "keyId"           TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "keyHash"         TEXT NOT NULL,
  "keyPrefix"       TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"      TIMESTAMP(3),
  "revokedAt"       TIMESTAMP(3),
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("keyId")
);
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");
CREATE INDEX "api_keys_tenantId_idx" ON "api_keys"("tenantId");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Webhooks: outbound event delivery
CREATE TABLE "webhook_endpoints" (
  "endpointId" TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "url"        TEXT NOT NULL,
  "secret"     TEXT NOT NULL,
  "eventTypes" TEXT[] NOT NULL,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("endpointId")
);
CREATE INDEX "webhook_endpoints_tenantId_idx" ON "webhook_endpoints"("tenantId");
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "webhook_deliveries" (
  "deliveryId"  TEXT NOT NULL,
  "endpointId"  TEXT NOT NULL,
  "eventType"   TEXT NOT NULL,
  "payload"     JSONB NOT NULL,
  "statusCode"  INTEGER,
  "succeeded"   BOOLEAN NOT NULL,
  "error"       TEXT,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("deliveryId")
);
CREATE INDEX "webhook_deliveries_endpointId_idx" ON "webhook_deliveries"("endpointId");
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("endpointId") ON DELETE CASCADE ON UPDATE CASCADE;
