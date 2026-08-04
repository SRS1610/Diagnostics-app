-- Attribution on a report must outlive the config rows it points at.
--
-- The foreign keys were created with Prisma's default action for an
-- optional relation, ON DELETE SET NULL. Deleting a technician or a
-- customer profile therefore succeeded and silently blanked that column
-- on every report referencing it — erasing the technician attribution
-- and profile linkage that the retention policy says is kept
-- indefinitely, and that QA metrics, redo history and dispute notes are
-- all derived from.
--
-- Switched to RESTRICT: an inspection's provenance can no longer be
-- removed, by the API or by anything else holding a connection.
ALTER TABLE "reports" DROP CONSTRAINT "reports_technicianId_fkey";
ALTER TABLE "reports" ADD CONSTRAINT "reports_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "technicians"("technicianId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reports" DROP CONSTRAINT "reports_profileId_fkey";
ALTER TABLE "reports" ADD CONSTRAINT "reports_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "customer_profiles"("profileId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Revocation without deletion: the replacement for removing someone from
-- the roster to cut off their access.
ALTER TABLE "technicians" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
