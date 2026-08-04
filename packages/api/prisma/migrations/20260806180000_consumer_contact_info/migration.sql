-- Consumer contact info for notification delivery (notificationDelivery.ts)
ALTER TABLE "reports" ADD COLUMN "consumerEmail" TEXT;
ALTER TABLE "reports" ADD COLUMN "consumerPhone" TEXT;
