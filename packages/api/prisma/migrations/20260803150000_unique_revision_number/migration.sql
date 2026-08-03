-- Revision numbers must be unique per report.
--
-- The application computed them with count-then-insert inside a
-- transaction, which does NOT serialise under READ COMMITTED: a plain
-- count takes no lock, so concurrent redos on one report all read the
-- same value and insert the same revisionNumber. Reproduced with eight
-- concurrent requests, which produced 1,2,2,2,2,5,6,7 — four revisions
-- labelled R2, and no R3 or R4 at all.
--
-- The route now row-locks the parent report as well, but this constraint
-- is the backstop: it makes the invariant true regardless of what any
-- future caller or script does.

-- Collapse any existing duplicates before the index can be created,
-- renumbering by insertion order so the sequence stays gapless.
WITH renumbered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "reportId" ORDER BY "revisedAt" ASC, "id" ASC) AS seq
  FROM "report_revisions"
)
UPDATE "report_revisions" r
SET "revisionNumber" = renumbered.seq
FROM renumbered
WHERE r."id" = renumbered."id" AND r."revisionNumber" <> renumbered.seq;

CREATE UNIQUE INDEX "report_revisions_reportId_revisionNumber_key"
  ON "report_revisions" ("reportId", "revisionNumber");
