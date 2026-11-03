import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, UsageOverview } from "@/lib/api";
import { BudgetBanner } from "./BudgetBanner";
import { BudgetForm } from "./BudgetForm";
import { UsageDashboard } from "./UsageDashboard";

const api = { usageStatus: vi.fn<ApiClient["usageStatus"]>() };
vi.mock("./AuthProvider", () => ({ useAuth: () => ({ api }) }));

const overview = (over: Partial<UsageOverview> = {}): UsageOverview => ({
  summary: {
    monthStart: "2026-11-01T00:00:00Z",
    totalUsd: 42.5,
    calls: 1234,
    unpricedCalls: 0,
    byFeature: [
      { feature: "agent", costUsd: 30, calls: 200 },
      { feature: "brand_new_feature", costUsd: 12.5, calls: 1034 },
    ],
    byPerson: [
      { userId: "u1", email: "bob@acme.example", costUsd: 40, calls: 1000 },
      { userId: "u2", email: null, costUsd: 2.5, calls: 234 },
    ],
    byDay: [
      { day: "2026-11-01", costUsd: 10 },
      { day: "2026-11-02", costUsd: 32.5 },
    ],
  },
  budget: { monthlyLimitUsd: 50, perPersonLimitUsd: null, warnAtPercent: 80 },
  companyLevel: "warn",
  ...over,
});

describe("UsageDashboard", () => {
  it("shows the month's total against the limit, by feature, person and day", () => {
    render(<UsageDashboard overview={overview()} />);
    expect(screen.getByText("November 2026")).toBeInTheDocument();
    expect(screen.getByText("$42.50")).toBeInTheDocument();
    expect(screen.getByText(/of a \$50\.00 monthly limit — nearing the limit/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "85");
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("brand_new_feature")).toBeInTheDocument();
    expect(screen.getByText("bob@acme.example")).toBeInTheDocument();
    expect(screen.getByText("Removed person")).toBeInTheDocument();
    expect(screen.getByLabelText("2026-11-02: $32.50")).toBeInTheDocument();
  });

  it("says when the limit is reached, notes unpriced calls, and copes with an empty month and no limit", () => {
    const { unmount } = render(
      <UsageDashboard overview={overview({ companyLevel: "stop", summary: { ...overview().summary, unpricedCalls: 3 } })} />,
    );
    expect(screen.getByText(/limit reached, AI work is paused/)).toBeInTheDocument();
    expect(screen.getByText(/3 calls used a model with no known price/)).toBeInTheDocument();
    unmount();

    const empty = { ...overview().summary, totalUsd: 0, calls: 0, byFeature: [], byPerson: [], byDay: [] };
    render(<UsageDashboard overview={overview({ summary: empty, budget: null, companyLevel: "ok" })} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getAllByText("Nothing yet this month.")).toHaveLength(2);
  });
});

describe("BudgetForm", () => {
  it("saves amounts, with empty meaning no limit", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<BudgetForm budget={{ monthlyLimitUsd: 50, perPersonLimitUsd: null, warnAtPercent: 80 }} isSaving={false} onSave={onSave} />);
    const monthly = screen.getByLabelText("Company limit per month ($)");
    expect(monthly).toHaveValue("50");
    await user.clear(monthly);
    await user.type(monthly, "120.5");
    await user.type(screen.getByLabelText("Limit per person per month ($)"), "10");
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    expect(onSave).toHaveBeenCalledWith({ monthlyLimitUsd: 120.5, perPersonLimitUsd: 10, warnAtPercent: 80 });
  });

  it("refuses negative amounts and a warning level outside 1 to 100", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<BudgetForm budget={null} isSaving={false} onSave={onSave} />);
    await user.type(screen.getByLabelText("Company limit per month ($)"), "-5");
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/amounts in dollars/);

    await user.clear(screen.getByLabelText("Company limit per month ($)"));
    const warn = screen.getByLabelText("Warn people at (%)");
    await user.clear(warn);
    await user.type(warn, "150");
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/1 to 100/);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("BudgetBanner", () => {
  it("shows nothing within budget", async () => {
    api.usageStatus.mockResolvedValueOnce({ level: "ok", limit: null, percentUsed: null });
    const { container } = render(<BudgetBanner />);
    await waitFor(() => expect(api.usageStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("warns as a person's own limit nears, and says when the company's is used up", async () => {
    api.usageStatus.mockResolvedValueOnce({ level: "warn", limit: "person", percentUsed: 85 });
    const { unmount } = render(<BudgetBanner />);
    expect(await screen.findByRole("status")).toHaveTextContent("Your AI budget for this month is 85% used.");
    unmount();

    api.usageStatus.mockResolvedValueOnce({ level: "warn", limit: "company", percentUsed: null });
    const second = render(<BudgetBanner />);
    expect(await screen.findByRole("status")).toHaveTextContent("Your company's AI budget for this month is nearly used up.");
    second.unmount();

    api.usageStatus.mockResolvedValueOnce({ level: "stop", limit: "company", percentUsed: null });
    render(<BudgetBanner />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/company's AI budget for this month is used up/);
  });
});
