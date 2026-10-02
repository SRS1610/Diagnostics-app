// Create (or reset the password of) a platform admin — the people who run
// TradeCall itself. There is deliberately no signup page for this role.
//
//   npm run platform:admin -- you@company.com "Your Name"
//
// Prints a generated password once; sign in and change it.

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

async function main() {
  const [email, ...nameParts] = process.argv.slice(2);
  const name = nameParts.join(" ") || "Platform admin";
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage: npm run platform:admin -- you@company.com "Your Name"');
    process.exit(1);
  }
  const db = new PrismaClient();
  try {
    const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing && existing.role !== "PLATFORM_ADMIN") {
      console.error(`${email} already belongs to a business account; use a different email for platform access.`);
      process.exit(1);
    }
    const password = randomBytes(12).toString("base64url");
    const passwordHash = await bcrypt.hash(password, 10);
    await db.user.upsert({
      where: { email: email.toLowerCase() },
      create: { email: email.toLowerCase(), name, role: "PLATFORM_ADMIN", businessId: null, passwordHash },
      update: { passwordHash, active: true },
    });
    console.log(`${existing ? "Reset" : "Created"} platform admin ${email}\nPassword (shown once): ${password}`);
  } finally {
    await db.$disconnect();
  }
}
main();
