// tests/fixtures.ts
//
// Builds TWO fully-populated tenants for every test file. That shape is
// deliberate: the property these tests exist to protect is that tenant A
// can never reach tenant B's data, and you cannot test that with a
// single-tenant fixture. Every resource below exists in both tenants so
// each isolation assertion has a real counterpart to try to reach.

import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export const PASSWORD = "test-password-123";

export interface TenantFixture {
  tenantId: string;
  companyName: string;
  adminEmail: string;
  profileId: string;
  profilePin: string;
  technicianId: string;
  badgeCode: string;
  licenseId: string;
  reportId: string;
}

export interface Fixtures {
  alpha: TenantFixture;
  beta: TenantFixture;
  masterEmail: string;
}

/**
 * Order matters — children before parents, or foreign keys block the
 * delete. Truncating rather than dropping keeps the migrated schema in
 * place so tests don't pay for a migration per file.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.activityLogEntry.deleteMany();
  await prisma.payoutRecord.deleteMany();
  await prisma.tradeInQuote.deleteMany();
  await prisma.marketplaceListing.deleteMany();
  await prisma.marketPriceEntry.deleteMany();
  await prisma.batchSession.deleteMany();
  await prisma.reportRevision.deleteMany();
  await prisma.dataWipeCertificate.deleteMany();
  await prisma.warrantyClaim.deleteMany();
  await prisma.report.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.license.deleteMany();
  await prisma.technician.deleteMany();
  await prisma.customerProfile.deleteMany();
  await prisma.portalUser.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.tenant.deleteMany();
}

async function seedTenant(name: string, pin: string, badgeCode: string): Promise<TenantFixture> {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const adminEmail = `admin@${name.toLowerCase()}.test`;

  const tenant = await prisma.tenant.create({
    data: { companyName: name, status: "active", primaryContactEmail: adminEmail },
  });

  await prisma.portalUser.create({
    data: { email: adminEmail, passwordHash, role: "tenant_admin", tenantId: tenant.tenantId },
  });

  const profile = await prisma.customerProfile.create({
    data: {
      tenantId: tenant.tenantId,
      customerName: `${name} Program`,
      pin,
      enabledTestIds: ["battery_health", "loud_speaker"],
    },
  });

  const technician = await prisma.technician.create({
    data: { tenantId: tenant.tenantId, displayName: `${name} Tech`, badgeCode },
  });

  const license = await prisma.license.create({
    data: {
      tenantId: tenant.tenantId,
      type: "per_inspection",
      status: "active",
      billingPeriodStart: new Date("2026-08-01"),
      billingPeriodEnd: new Date("2026-08-31"),
      includedQuota: 100,
      overageRatePerInspection: 2.5,
    },
  });

  const report = await prisma.report.create({
    data: {
      tenantId: tenant.tenantId,
      profileId: profile.profileId,
      technicianId: technician.technicianId,
      deviceMake: "Apple",
      deviceModel: "iPhone 13",
      serialNumber: `SERIAL-${name}`,
      imei: "356938035643809",
      captureSource: "barcode",
      results: [],
      overallStatus: "pass",
    },
  });

  await prisma.activityLogEntry.create({
    data: {
      tenantId: tenant.tenantId,
      actorUserId: "seed",
      actorRole: "tenant_admin",
      action: "portal_login",
      targetType: "session",
      targetId: "seed",
      details: `${name} seed entry`,
    },
  });

  return {
    tenantId: tenant.tenantId,
    companyName: name,
    adminEmail,
    profileId: profile.profileId,
    profilePin: pin,
    technicianId: technician.technicianId,
    badgeCode,
    licenseId: license.licenseId,
    reportId: report.reportId,
  };
}

export async function seedTwoTenants(): Promise<Fixtures> {
  await resetDatabase();

  const masterEmail = "master@platform.test";
  await prisma.portalUser.create({
    data: {
      email: masterEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role: "master_admin",
      tenantId: null,
    },
  });

  // Both tenants deliberately use the SAME pin and badge code. Those are
  // only unique WITHIN a tenant (schema's @@unique([tenantId, pin]) and
  // ([tenantId, badgeCode])), so identical values across tenants are the
  // case most likely to expose a lookup that forgot its tenant filter.
  const alpha = await seedTenant("Alpha", "4726", "TEC-1000");
  const beta = await seedTenant("Beta", "4726", "TEC-1000");

  return { alpha, beta, masterEmail };
}
