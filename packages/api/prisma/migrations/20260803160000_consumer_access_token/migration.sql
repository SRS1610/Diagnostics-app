-- Consumer-facing access to a report.
--
-- consumerToken is a capability: whoever holds it can read that one
-- report's public summary and act on its offer, with no login. It is
-- therefore added as a column that must be unguessable and unique.
--
-- Existing rows are backfilled with random values rather than anything
-- derived from reportId — a token derived from an id a technician can
-- see would let anyone who has seen one report reach another.
ALTER TABLE "reports" ADD COLUMN "consumerToken" TEXT;
ALTER TABLE "reports" ADD COLUMN "offerDeclinedAt" TIMESTAMP(3);

UPDATE "reports"
-- Two UUIDv4s concatenated: 256 bits of randomness without depending on
-- the pgcrypto extension being installed.
SET "consumerToken" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE "consumerToken" IS NULL;

ALTER TABLE "reports" ALTER COLUMN "consumerToken" SET NOT NULL;
CREATE UNIQUE INDEX "reports_consumerToken_key" ON "reports"("consumerToken");
