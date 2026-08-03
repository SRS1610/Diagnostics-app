-- One active license per tenant.
--
-- Nothing previously stopped a tenant accumulating several concurrently
-- "active" licenses, and the session gate had no defined way to choose
-- between them: it ordered by billingPeriodStart, which ties routinely
-- because billing periods start on the 1st. An organisation out of
-- metered credits could therefore be evaluated against a different
-- active license and allowed to run work it had not paid for.
--
-- Enforced in the database rather than only in application code so no
-- future route, script, or manual fix can reintroduce the ambiguity.

-- Existing violations must be resolved before the index can be created.
-- Keep the most recently started license per tenant (tie broken on id,
-- matching the API's ordering) and mark the rest expired. "expired" is
-- used rather than a new status value because checkLicense() in
-- licensing.ts explicitly blocks on it; an unrecognised status would
-- fall through its switch and could return allowed:true.
WITH ranked AS (
  SELECT
    "licenseId",
    ROW_NUMBER() OVER (
      PARTITION BY "tenantId"
      ORDER BY "billingPeriodStart" DESC, "licenseId" ASC
    ) AS rn
  FROM "licenses"
  WHERE "status" = 'active'
)
UPDATE "licenses"
SET "status" = 'expired'
WHERE "licenseId" IN (SELECT "licenseId" FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "licenses_one_active_per_tenant"
  ON "licenses" ("tenantId")
  WHERE "status" = 'active';
