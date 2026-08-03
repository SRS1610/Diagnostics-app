-- CreateTable
CREATE TABLE "market_prices" (
    "priceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "storageGb" INTEGER NOT NULL,
    "gradeBasePrices" JSONB NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_prices_pkey" PRIMARY KEY ("priceId")
);

-- CreateTable
CREATE TABLE "trade_in_quotes" (
    "quoteId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "deviceModel" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "basePrice" DOUBLE PRECISION NOT NULL,
    "deductions" JSONB NOT NULL,
    "finalOffer" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "quotedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "priceSource" TEXT NOT NULL DEFAULT 'unverified_seed_data',
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "trade_in_quotes_pkey" PRIMARY KEY ("quoteId")
);

-- CreateTable
CREATE TABLE "payout_records" (
    "payoutId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "amount" DOUBLE PRECISION NOT NULL,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "reference" TEXT,
    "failureReason" TEXT,

    CONSTRAINT "payout_records_pkey" PRIMARY KEY ("payoutId")
);

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "listingId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "askingPrice" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("listingId")
);

-- CreateTable
CREATE TABLE "batch_sessions" (
    "batchId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "profileId" TEXT,
    "technicianId" TEXT,
    "deviceSerials" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "batch_sessions_pkey" PRIMARY KEY ("batchId")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_prices_tenantId_model_storageGb_key" ON "market_prices"("tenantId", "model", "storageGb");

-- CreateIndex
CREATE UNIQUE INDEX "trade_in_quotes_reportId_key" ON "trade_in_quotes"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_records_quoteId_key" ON "payout_records"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_reportId_key" ON "marketplace_listings"("reportId");

-- AddForeignKey
ALTER TABLE "market_prices" ADD CONSTRAINT "market_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_in_quotes" ADD CONSTRAINT "trade_in_quotes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_in_quotes" ADD CONSTRAINT "trade_in_quotes_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("reportId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_records" ADD CONSTRAINT "payout_records_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "trade_in_quotes"("quoteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("reportId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_sessions" ADD CONSTRAINT "batch_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
