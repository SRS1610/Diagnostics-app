-- Org settings: the two defaults CLAUDE.md names under Settings —
-- "defaults (wipe standard, PIN length)". Both are enforced, not
-- cosmetic: minPinLength gates profile PIN creation/update, and
-- requirePurgeWipe gates which wipe certificates a tenant can record.
ALTER TABLE "tenants" ADD COLUMN "minPinLength" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "tenants" ADD COLUMN "requirePurgeWipe" BOOLEAN NOT NULL DEFAULT false;
