import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RankerStatus } from "@/lib/api";
import { RankerStatusPanel } from "./RankerStatusPanel";

type Details = NonNullable<Extract<RankerStatus, { state: "on" | "off" }>["details"]>;
const trained = (state: "on" | "off", details: Partial<Details> | null = {}): RankerStatus => ({
  state,
  minAnswers: 150,
  trainedAt: "2026-11-09T08:00:00.000Z",
  details: details === null ? null : { reason: "too_few", answers: 40, examples: 200, holdoutMrr: 0, baselineMrr: 0, ...details },
});

describe("RankerStatusPanel", () => {
  it("explains that nothing has been learned yet, and how that starts", () => {
    render(<RankerStatusPanel status={{ state: "never_trained", minAnswers: 150 }} />);
    expect(screen.getByText("Not trained yet")).toBeInTheDocument();
    expect(screen.getByText(/Results keep their usual order/)).toBeInTheDocument();
  });

  it("says it is on, from how many ratings, and how much better it ranked held-back answers", () => {
    render(<RankerStatusPanel status={trained("on", { reason: "better", answers: 180, holdoutMrr: 0.74, baselineMrr: 0.61 })} />);
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText(/180 rated answers/)).toBeInTheDocument();
    expect(screen.getByText(/0\.74.*0\.61/)).toBeInTheDocument();
  });

  it("says why it is off: too few ratings, or no clear gain", () => {
    const { rerender } = render(<RankerStatusPanel status={trained("off")} />);
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText(/40 rated answers so far and needs at least 150/)).toBeInTheDocument();
    rerender(<RankerStatusPanel status={trained("off", { reason: "no_gain", answers: 200 })} />);
    expect(screen.getByText(/did not rank answers clearly better/)).toBeInTheDocument();
    rerender(<RankerStatusPanel status={trained("off", { reason: "better" })} />);
    expect(screen.getByText(/saved result could not be used/)).toBeInTheDocument();
  });

  it("still says it is on when the details of its training could not be read", () => {
    render(<RankerStatusPanel status={trained("on", null)} />);
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
  });
});
