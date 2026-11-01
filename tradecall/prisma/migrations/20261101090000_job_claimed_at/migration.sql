-- Stuck-job recovery used to compare against runAt, so with two workers one
-- could reset the other's in-flight job and send the same text twice.
ALTER TABLE "Job" ADD COLUMN "claimedAt" TIMESTAMP(3);
