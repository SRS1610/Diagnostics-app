// packages/api/prisma/seed.ts
//
// Seeds a working development environment: one tenant (Acme Wireless),
// a master_admin, a tenant_admin, a technician, and a license — enough
// to log in and see something real on day one. Run with:
//   npx prisma db seed

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.create({
    data: {
      companyName: "Acme Wireless",
      status: "active",
      primaryContactEmail: "admin@acmewireless.com",
    },
  });

  const passwordHash = await bcrypt.hash("changeme123", 10);

  await prisma.portalUser.create({
    data: {
      email: "master@platform.com",
      passwordHash,
      role: "master_admin",
      tenantId: null,
    },
  });

  await prisma.portalUser.create({
    data: {
      email: "admin@acmewireless.com",
      passwordHash,
      role: "tenant_admin",
      tenantId: tenant.tenantId,
    },
  });

  await prisma.customerProfile.create({
    data: {
      tenantId: tenant.tenantId,
      customerName: "Acme Wireless",
      pin: "4726",
      enabledTestIds: ["battery_health", "camera_back", "camera_front", "cosmetic_grading", "loud_speaker"],
    },
  });

  await prisma.technician.create({
    data: {
      tenantId: tenant.tenantId,
      displayName: "J. Alvarez",
      badgeCode: "TEC-1042",
    },
  });

  await prisma.license.create({
    data: {
      tenantId: tenant.tenantId,
      type: "per_inspection",
      status: "active",
      billingPeriodStart: new Date("2026-08-01"),
      billingPeriodEnd: new Date("2026-08-31"),
      includedQuota: 500,
      overageRatePerInspection: 2.5,
    },
  });

  console.log("Seed complete.");
  console.log("  Master admin: master@platform.com / changeme123");
  console.log("  Tenant admin: admin@acmewireless.com / changeme123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
