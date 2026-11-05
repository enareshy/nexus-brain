// Monthly check of the usage ledger against the provider's bill (FR-MET-04). The ledger prices each
// call from list prices, so small differences are expected; the exit criterion is within 3%.

export const RECONCILE_TOLERANCE = 0.03;

export interface ModelCost {
  readonly model: string;
  readonly costUsd: number;
}

export interface ReconcileLine {
  readonly model: string;
  readonly ledgerUsd: number;
  readonly billedUsd: number;
  /** (ledger − billed) / billed. Null when nothing was billed for this model. */
  readonly difference: number | null;
}

export interface ReconcileReport {
  readonly lines: readonly ReconcileLine[];
  readonly ledgerUsd: number;
  readonly billedUsd: number;
  readonly difference: number | null;
  /** Calls the ledger could not price, which it cannot compare. */
  readonly unpricedCalls: number;
  /** Models off by more than the tolerance, or found on only one side. */
  readonly modelsOff: readonly string[];
  readonly withinTolerance: boolean;
}

/** Below this, a model's difference is rounding, not a missing call. */
const NEGLIGIBLE_USD = 0.01;

const MODEL = /^[\w.:@/-]{1,100}$/;

/**
 * The bill as `model,cost_usd` lines, with that header, one line per model or per model and day
 * (summed). Prepared by an operator from the provider's cost report for one month.
 */
export function parseBill(csv: string): ModelCost[] {
  const lines = csv.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines[0]?.toLowerCase() !== "model,cost_usd") throw new Error('The bill must start with the header "model,cost_usd"');
  return lines.slice(1).map((line, index) => {
    const [model = "", cost = "", ...rest] = line.split(",");
    const costUsd = Number(cost);
    if (rest.length || !MODEL.test(model) || cost.trim() === "" || !Number.isFinite(costUsd) || costUsd < 0) {
      throw new Error(`Line ${index + 2} of the bill is not "model,cost_usd"`);
    }
    return { model, costUsd };
  });
}

function sumByModel(rows: readonly ModelCost[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.model, (totals.get(row.model) ?? 0) + row.costUsd);
  return totals;
}

const relative = (ledger: number, billed: number) => (billed > 0 ? (ledger - billed) / billed : ledger > 0 ? null : 0);

export function reconcile(ledger: readonly ModelCost[], bill: readonly ModelCost[], unpricedCalls = 0, tolerance = RECONCILE_TOLERANCE): ReconcileReport {
  const ledgerByModel = sumByModel(ledger);
  const billByModel = sumByModel(bill);
  const models = [...new Set([...ledgerByModel.keys(), ...billByModel.keys()])].sort();
  const lines = models.map((model) => {
    const ledgerUsd = ledgerByModel.get(model) ?? 0;
    const billedUsd = billByModel.get(model) ?? 0;
    return { model, ledgerUsd, billedUsd, difference: relative(ledgerUsd, billedUsd) };
  });
  const ledgerUsd = lines.reduce((sum, line) => sum + line.ledgerUsd, 0);
  const billedUsd = lines.reduce((sum, line) => sum + line.billedUsd, 0);
  const difference = relative(ledgerUsd, billedUsd);
  // Per model too, so a model over and another under cannot cancel out in the total.
  const modelsOff = lines
    .filter((l) => Math.max(l.ledgerUsd, l.billedUsd) >= NEGLIGIBLE_USD && (l.difference === null || Math.abs(l.difference) > tolerance))
    .map((l) => l.model);
  return {
    lines,
    ledgerUsd,
    billedUsd,
    difference,
    unpricedCalls,
    modelsOff,
    // Unpriced calls make the comparison incomplete, so it cannot pass with any.
    withinTolerance: difference !== null && Math.abs(difference) <= tolerance && unpricedCalls === 0 && modelsOff.length === 0,
  };
}

const usd = (value: number) => `$${value.toFixed(2)}`;
const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

export function formatReport(month: string, report: ReconcileReport): string {
  const rows = report.lines.map((l) => `  ${l.model.padEnd(28)} ledger ${usd(l.ledgerUsd).padStart(12)}  billed ${usd(l.billedUsd).padStart(12)}  ${percent(l.difference)}`);
  return [
    `Usage ledger against the bill for ${month}`,
    ...rows,
    `  ${"Total".padEnd(28)} ledger ${usd(report.ledgerUsd).padStart(12)}  billed ${usd(report.billedUsd).padStart(12)}  ${percent(report.difference)}`,
    ...(report.unpricedCalls ? [`  ${report.unpricedCalls} calls had no known price and are not compared.`] : []),
    ...(report.modelsOff.length ? [`  Off by more than ${percent(RECONCILE_TOLERANCE)}: ${report.modelsOff.join(", ")}.`] : []),
    report.withinTolerance ? `Within ${percent(RECONCILE_TOLERANCE)}.` : `Not within ${percent(RECONCILE_TOLERANCE)}: check prices in models.ts and calls missing from the ledger.`,
  ].join("\n");
}
