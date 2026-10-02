// What each plan includes. Usage beyond includedTexts is allowed and shown
// as overage (for billing later) — a busy week should never stop a
// business's customers getting their text-back.

import type { Plan } from "@prisma/client";

export const PLANS: Record<Plan, { label: string; seats: number; includedTexts: number }> = {
  STARTER: { label: "Starter", seats: 2, includedTexts: 500 },
  PRO: { label: "Pro", seats: 5, includedTexts: 2000 },
  TEAM: { label: "Team", seats: 20, includedTexts: 6000 },
};
