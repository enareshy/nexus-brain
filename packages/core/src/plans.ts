/**
 * Plans and their monthly credit pools (FR-MET-02). These are placeholders until pricing is decided:
 * an operator sets a company's plan, and may give it a different number of credits than listed here.
 */
export const PLANS = Object.freeze({
  pilot: { label: "Pilot", monthlyCredits: 5_000 },
  team: { label: "Team", monthlyCredits: 20_000 },
  business: { label: "Business", monthlyCredits: 100_000 },
} satisfies Record<string, { readonly label: string; readonly monthlyCredits: number }>);

export type PlanId = keyof typeof PLANS;

/** One credit is one cent of AI cost at the provider's list prices. */
export const USD_PER_CREDIT = 0.01;

export const MAX_TOP_UP_CREDITS = 1_000_000;

export function isPlanId(value: string): value is PlanId {
  return Object.hasOwn(PLANS, value);
}

/** A plan's name to show, falling back to its id for one no longer listed. */
export function planLabel(plan: string): string {
  return isPlanId(plan) ? PLANS[plan].label : plan;
}

/** Credits used, rounded up, so a part-used credit counts as used. */
export function creditsFor(usd: number): number {
  return Math.ceil(Math.round((usd / USD_PER_CREDIT) * 1e6) / 1e6);
}
