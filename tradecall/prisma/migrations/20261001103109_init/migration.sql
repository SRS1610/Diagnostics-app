-- CreateEnum
CREATE TYPE "CallMode" AS ENUM ('RING_OWNER', 'FORWARDED');

-- CreateEnum
CREATE TYPE "CallState" AS ENUM ('RINGING_OWNER', 'SCREENING', 'CONNECTING', 'CONNECTED', 'VOICEMAIL', 'SELF_TEST', 'ENDED');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('PENDING', 'ANSWERED', 'MISSED');

-- CreateEnum
CREATE TYPE "MissReason" AS ENUM ('NO_ANSWER', 'NOT_ACCEPTED', 'CALLER_HUNG_UP', 'FORWARDED');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'ENGAGED', 'QUALIFIED', 'SCHEDULED', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('AUTO_REPLY', 'INTAKE', 'NUDGE', 'REMINDER', 'OWNER', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('NUDGE', 'REMINDER');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'CANCELED', 'FAILED');

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "ownerPhone" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "callMode" "CallMode" NOT NULL DEFAULT 'RING_OWNER',
    "ringSeconds" INTEGER NOT NULL DEFAULT 18,
    "screenCalls" BOOLEAN NOT NULL DEFAULT true,
    "voicemailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "hours" JSONB NOT NULL,
    "missedText" TEXT NOT NULL,
    "afterHoursText" TEXT NOT NULL,
    "intakeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nudgeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nudgeAfterMin" INTEGER NOT NULL DEFAULT 120,
    "dedupeMin" INTEGER NOT NULL DEFAULT 60,
    "avgJobCents" INTEGER NOT NULL DEFAULT 45000,
    "digestEnabled" BOOLEAN NOT NULL DEFAULT true,
    "digestSentAt" TIMESTAMP(3),
    "leadSeq" INTEGER NOT NULL DEFAULT 0,
    "lastAlertLeadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "callerLegId" TEXT NOT NULL,
    "ownerLegId" TEXT,
    "sessionId" TEXT,
    "fromNumber" TEXT NOT NULL,
    "state" "CallState" NOT NULL DEFAULT 'RINGING_OWNER',
    "outcome" "CallOutcome" NOT NULL DEFAULT 'PENDING',
    "missReason" "MissReason",
    "afterHours" BOOLEAN NOT NULL DEFAULT false,
    "callerAnswered" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "leadId" TEXT,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voicemail" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "audio" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voicemail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" INTEGER NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "job" TEXT,
    "address" TEXT,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "intakeStep" INTEGER NOT NULL DEFAULT 0,
    "valueCents" INTEGER,
    "appointmentAt" TIMESTAMP(3),
    "wonAt" TIMESTAMP(3),
    "notes" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "body" TEXT NOT NULL,
    "providerId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptOut" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Business_email_key" ON "Business"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Business_phoneNumber_key" ON "Business"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Call_callerLegId_key" ON "Call"("callerLegId");

-- CreateIndex
CREATE UNIQUE INDEX "Call_ownerLegId_key" ON "Call"("ownerLegId");

-- CreateIndex
CREATE INDEX "Call_businessId_startedAt_idx" ON "Call"("businessId", "startedAt");

-- CreateIndex
CREATE INDEX "Call_sessionId_idx" ON "Call"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Voicemail_callId_key" ON "Voicemail"("callId");

-- CreateIndex
CREATE INDEX "Lead_businessId_phone_idx" ON "Lead"("businessId", "phone");

-- CreateIndex
CREATE INDEX "Lead_businessId_stage_idx" ON "Lead"("businessId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_businessId_code_key" ON "Lead"("businessId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Message_providerId_key" ON "Message"("providerId");

-- CreateIndex
CREATE INDEX "Message_businessId_createdAt_idx" ON "Message"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_leadId_createdAt_idx" ON "Message"("leadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OptOut_businessId_phone_key" ON "OptOut"("businessId", "phone");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voicemail" ADD CONSTRAINT "Voicemail_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voicemail" ADD CONSTRAINT "Voicemail_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptOut" ADD CONSTRAINT "OptOut_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
