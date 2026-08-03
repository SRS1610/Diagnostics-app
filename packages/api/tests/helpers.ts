// tests/helpers.ts

import request from "supertest";
import type { Express } from "express";
import { PASSWORD } from "./fixtures";

export async function portalLogin(app: Express, email: string): Promise<string> {
  const res = await request(app).post("/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`portal login failed for ${email}: ${res.status} ${res.text}`);
  return res.body.token;
}

export async function technicianLogin(app: Express, tenantId: string, badgeCode: string): Promise<string> {
  const res = await request(app).post("/technicians/login").send({ tenantId, badgeCode });
  if (res.status !== 200) throw new Error(`technician login failed: ${res.status} ${res.text}`);
  return res.body.token;
}

/** Master admin dropping into one tenant's view — the only way a
 *  master_admin can reach tenant-scoped routes. */
export async function enterTenantView(app: Express, masterToken: string, tenantId: string): Promise<string> {
  const res = await request(app)
    .post("/auth/enter-tenant-view")
    .set("Authorization", `Bearer ${masterToken}`)
    .send({ tenantId });
  if (res.status !== 200) throw new Error(`enter-tenant-view failed: ${res.status} ${res.text}`);
  return res.body.token;
}

export function validReportBody(overrides: Record<string, unknown> = {}) {
  return {
    device: {
      make: "Apple",
      model: "iPhone 13",
      serialNumber: "TEST-SERIAL",
      imei: "356938035643809",
      captureSource: "manual",
    },
    results: [],
    ...overrides,
  };
}
