-- CreateTable
CREATE TABLE "tenants" (
    "tenantId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trial',
    "primaryContactEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "profileId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "enabledTestIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("profileId")
);

-- CreateTable
CREATE TABLE "licenses" (
    "licenseId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "billingPeriodStart" TIMESTAMP(3) NOT NULL,
    "billingPeriodEnd" TIMESTAMP(3) NOT NULL,
    "includedQuota" INTEGER,
    "usageThisPeriod" INTEGER NOT NULL DEFAULT 0,
    "overageRatePerInspection" DOUBLE PRECISION,
    "seatLimit" INTEGER,
    "activeSeats" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("licenseId")
);

-- CreateTable
CREATE TABLE "invoices" (
    "invoiceId" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "billingPeriodStart" TIMESTAMP(3) NOT NULL,
    "billingPeriodEnd" TIMESTAMP(3) NOT NULL,
    "lineItems" JSONB NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("invoiceId")
);

-- CreateTable
CREATE TABLE "portal_users" (
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_users_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "technicians" (
    "technicianId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "badgeCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "technicians_pkey" PRIMARY KEY ("technicianId")
);

-- CreateTable
CREATE TABLE "reports" (
    "reportId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "profileId" TEXT,
    "technicianId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceMake" TEXT NOT NULL,
    "deviceModel" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "imei" TEXT NOT NULL,
    "imei2" TEXT,
    "captureSource" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "overallStatus" TEXT NOT NULL,
    "routing" TEXT,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("reportId")
);

-- CreateTable
CREATE TABLE "report_revisions" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "revisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisedByTechnicianId" TEXT NOT NULL,
    "testIdsRedone" TEXT[],
    "reason" TEXT,

    CONSTRAINT "report_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_wipe_certificates" (
    "certificateId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "deviceSerial" TEXT NOT NULL,
    "imei" TEXT NOT NULL,
    "standard" TEXT NOT NULL,
    "wipedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedByTechnicianId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,

    CONSTRAINT "data_wipe_certificates_pkey" PRIMARY KEY ("certificateId")
);

-- CreateTable
CREATE TABLE "warranty_claims" (
    "claimId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "deviceSerial" TEXT NOT NULL,
    "claimedIssue" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warrantyExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolutionNotes" TEXT,

    CONSTRAINT "warranty_claims_pkey" PRIMARY KEY ("claimId")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "entryId" TEXT NOT NULL,
    "tenantId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "details" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("entryId")
);

-- CreateTable
CREATE TABLE "disputes" (
    "disputeId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "disputingItem" TEXT NOT NULL,
    "customerNote" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_review',
    "resolvedByUserId" TEXT,
    "resolutionNotes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("disputeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_tenantId_pin_key" ON "customer_profiles"("tenantId", "pin");

-- CreateIndex
CREATE UNIQUE INDEX "portal_users_email_key" ON "portal_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "technicians_tenantId_badgeCode_key" ON "technicians"("tenantId", "badgeCode");

-- CreateIndex
CREATE INDEX "reports_tenantId_serialNumber_idx" ON "reports"("tenantId", "serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "data_wipe_certificates_reportId_key" ON "data_wipe_certificates"("reportId");

-- CreateIndex
CREATE INDEX "activity_log_tenantId_timestamp_idx" ON "activity_log"("tenantId", "timestamp");

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses"("licenseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_users" ADD CONSTRAINT "portal_users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "customer_profiles"("profileId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("technicianId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_revisions" ADD CONSTRAINT "report_revisions_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("reportId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_wipe_certificates" ADD CONSTRAINT "data_wipe_certificates_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("reportId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("reportId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE SET NULL ON UPDATE CASCADE;
