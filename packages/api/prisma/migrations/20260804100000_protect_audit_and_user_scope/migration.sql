-- The remaining two optional relations carrying Prisma's default
-- ON DELETE SET NULL, found by sweeping for the same defect class fixed
-- in 20260804090000_preserve_attribution.
--
-- Neither is reachable through the API today (there is no tenant-delete
-- route), so this closes a latent hole rather than an active one — but
-- in both cases NULL is not an absence, it is a meaning:
--
--   activity_log.tenantId IS NULL  ->  "platform-level action"
--   portal_users.tenantId         IS NULL  ->  "master_admin"
--
-- So SetNull would not orphan these rows, it would RELABEL them: a
-- deleted tenant's audit entries would read as master-admin platform
-- actions, and its tenant admins would become users whose stored shape
-- claims a scope their role does not have.
ALTER TABLE "activity_log" DROP CONSTRAINT "activity_log_tenantId_fkey";
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portal_users" DROP CONSTRAINT "portal_users_tenantId_fkey";
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
