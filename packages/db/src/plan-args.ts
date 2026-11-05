import { isPlanId, PLANS, UuidSchema } from "@brain/core";
import type { Plan } from "./credits.js";

const MAX_CREDITS = 100_000_000;

/** `<tenant-id> <plan> [monthly-credits]`. The credits default to the plan's own. */
export function parsePlanArgs(args: readonly string[]): { readonly tenantId: string; readonly plan: Plan } {
  const [tenantId = "", plan = "", credits] = args;
  if (args.length < 2 || args.length > 3) throw new Error("Usage: set-plan <tenant-id> <plan> [monthly-credits]");
  if (!UuidSchema.safeParse(tenantId).success) throw new Error("The tenant id must be a UUID");
  if (!isPlanId(plan)) throw new Error(`Unknown plan. Choose one of: ${Object.keys(PLANS).join(", ")}`);
  // Digits only: Number("") is 0, which would silently stop every agent in the company.
  if (credits !== undefined && !/^\d+$/.test(credits)) throw new Error("Monthly credits must be a whole number");
  const monthlyCredits = credits === undefined ? PLANS[plan].monthlyCredits : Number(credits);
  if (!Number.isInteger(monthlyCredits) || monthlyCredits < 0 || monthlyCredits > MAX_CREDITS) {
    throw new Error(`Monthly credits must be a whole number from 0 to ${MAX_CREDITS}`);
  }
  return { tenantId, plan: { plan, monthlyCredits } };
}
