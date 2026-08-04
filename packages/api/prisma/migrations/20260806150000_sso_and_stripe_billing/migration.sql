-- SSO: tenant-level OIDC connection
CREATE TABLE "sso_connections" (
  "connectionId"          TEXT NOT NULL,
  "tenantId"              TEXT NOT NULL,
  "domain"                TEXT NOT NULL,
  "issuer"                TEXT NOT NULL,
  "clientId"              TEXT NOT NULL,
  "clientSecret"          TEXT NOT NULL,
  "authorizationEndpoint" TEXT NOT NULL,
  "tokenEndpoint"         TEXT NOT NULL,
  "jwksUri"               TEXT NOT NULL,
  "enabled"               BOOLEAN NOT NULL DEFAULT false,
  "enforced"              BOOLEAN NOT NULL DEFAULT false,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("connectionId")
);
CREATE UNIQUE INDEX "sso_connections_tenantId_key" ON "sso_connections"("tenantId");
CREATE UNIQUE INDEX "sso_connections_domain_key" ON "sso_connections"("domain");
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PortalUser gains an SSO identity link
ALTER TABLE "portal_users" ADD COLUMN "ssoSubject" TEXT;
CREATE UNIQUE INDEX "portal_users_tenantId_ssoSubject_key" ON "portal_users"("tenantId", "ssoSubject");

-- Stripe billing
ALTER TABLE "tenants" ADD COLUMN "stripeCustomerId" TEXT;
CREATE UNIQUE INDEX "tenants_stripeCustomerId_key" ON "tenants"("stripeCustomerId");

ALTER TABLE "licenses" ADD COLUMN "stripeSubscriptionId" TEXT;
CREATE UNIQUE INDEX "licenses_stripeSubscriptionId_key" ON "licenses"("stripeSubscriptionId");
