// src/lib/prisma.ts
//
// The one PrismaClient for this process.
//
// Every route and middleware file previously ran `const prisma = new
// PrismaClient()` at module load — 19 of them by the time this was
// found. Each PrismaClient opens its OWN connection pool against
// Postgres, so the API was quietly running 19 separate pools for one
// process the whole time. It worked in normal operation because
// Postgres's default max_connections (100) comfortably covers 19 small
// pools plus headroom, so nothing outside a saturated test run ever hit
// the ceiling — which is exactly why it went unnoticed rather than why
// it was fine.
//
// It stopped being comfortable the moment two more files did the same
// thing: adding users.ts and compliance.ts pushed the full Jest suite
// (ten files, each importing several of these route modules to build an
// app instance) over "remaining connection slots are reserved for roles
// with the SUPERUSER attribute" — Postgres refusing new connections
// because ordinary roles had exhausted their allowance.
//
// One client, imported everywhere. Prisma's client is safe to share
// across concurrent requests — it isn't per-request state, it's a
// connection-pooled query engine — so there was never a reason for one
// per file.
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
