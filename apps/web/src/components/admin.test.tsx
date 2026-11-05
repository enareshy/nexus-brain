import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createApiClient, type AiSettings } from "@/lib/api";
import { AiSettingsForm, describeAiSettings } from "./AiSettingsForm";

const defaults: AiSettings = { modelChoice: "premium", agentsEnabled: true, automaticAgentsEnabled: true, automaticRunsPerDay: 10 };

describe("AiSettingsForm (FR-ADM-02)", () => {
  it("saves only once something changed, with the model and agent limits chosen", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<AiSettingsForm settings={defaults} canChange isSaving={false} onSave={onSave} />);
    const save = screen.getByRole("button", { name: "Save settings" });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Balanced/ }));
    await user.selectOptions(screen.getByLabelText("Automatic runs a day, for each person"), "3");
    await user.click(save);
    expect(onSave).toHaveBeenCalledWith({ ...defaults, modelChoice: "standard", automaticRunsPerDay: 3 });
  });

  it("disables the automatic agent settings while agents are off", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<AiSettingsForm settings={defaults} canChange isSaving={false} onSave={onSave} />);
    await user.click(screen.getByRole("checkbox", { name: /People can use agents/ }));
    expect(screen.getByRole("checkbox", { name: /Automatic agents can run/ })).toBeDisabled();
    expect(screen.getByLabelText("Automatic runs a day, for each person")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onSave).toHaveBeenCalledWith({ ...defaults, agentsEnabled: false });
  });

  it("shows members the settings in words, with nothing to change", () => {
    render(<AiSettingsForm settings={{ ...defaults, automaticAgentsEnabled: false }} canChange={false} isSaving={false} onSave={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Automatic agents are turned off.")).toBeInTheDocument();
    expect(screen.getByText("Only an admin can change these.")).toBeInTheDocument();
  });

  it("describes each combination plainly", () => {
    expect(describeAiSettings(defaults)).toEqual([
      "Answers and agents use the most capable model.",
      "Agents are on.",
      "Automatic agents are on, up to 10 runs a day for each person.",
    ]);
    expect(describeAiSettings({ ...defaults, modelChoice: "standard", automaticRunsPerDay: 1 })[2]).toBe("Automatic agents are on, up to 1 run a day for each person.");
    expect(describeAiSettings({ ...defaults, agentsEnabled: false }).slice(1)).toEqual(["Agents are turned off.", "Automatic agents do not run while agents are off."]);
  });
});

describe("the AI settings API client", () => {
  it("reads the settings and saves them as an admin", async () => {
    const cautious = { ...defaults, modelChoice: "standard" as const };
    const replies = [defaults, cautious];
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, data: replies.shift() }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as unknown as typeof fetch);
    expect(await api.aiSettings()).toEqual(defaults);
    expect(await api.setAiSettings(cautious)).toEqual(cautious);
    expect(fetchImpl.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`)).toEqual([
      "GET /ai-settings",
      "POST /admin/ai-settings",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).toEqual(cautious);
  });
});
