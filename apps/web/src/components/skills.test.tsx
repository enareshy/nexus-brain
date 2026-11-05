import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createApiClient, type Skill } from "@/lib/api";
import { SkillEditor } from "./SkillEditor";
import { SkillList } from "./SkillList";
import { SkillPicker } from "./SkillPicker";

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: "s1",
  name: "Weekly status",
  instructions: "Summarise this week's changes in three bullets.",
  tools: ["search_documents"],
  shared: false,
  mine: true,
  ownerName: "Bob",
  readable: true,
  updatedAt: "2026-11-05T00:00:00Z",
  ...over,
});

describe("SkillEditor (FR-AST-08)", () => {
  it("saves a name, instructions, the chosen tools in a fixed order, and sharing, then clears", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => true);
    render(<SkillEditor isBusy={false} submitLabel="Add skill" onSubmit={onSubmit} />);
    const add = screen.getByRole("button", { name: "Add skill" });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText("Name"), "  Weekly status ");
    await user.type(screen.getByLabelText("Instructions"), "Line one{enter}Line two");
    await user.click(screen.getByLabelText("Propose Jira comments"));
    await user.click(screen.getByLabelText("See where you can make Jira changes"));
    await user.click(screen.getByLabelText(/Share with my company/));
    await user.click(add);
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Weekly status",
      instructions: "Line one\nLine two",
      tools: ["search_documents", "list_jira_projects", "propose_jira_comment"],
      shared: true,
    });
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("needs at least one tool", async () => {
    const user = userEvent.setup();
    render(<SkillEditor isBusy={false} submitLabel="Add skill" onSubmit={vi.fn()} />);
    await user.type(screen.getByLabelText("Name"), "x");
    await user.type(screen.getByLabelText("Instructions"), "y");
    await user.click(screen.getByLabelText("Search and read your connected tools"));
    expect(screen.getByRole("button", { name: "Add skill" })).toBeDisabled();
  });
});

describe("SkillList", () => {
  it("lets only the owner edit or delete, and asks before deleting a shared skill", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onUpdate = vi.fn(async () => true);
    render(
      <SkillList
        skills={[skill({ shared: true }), skill({ id: "s2", name: "Theirs", mine: false, shared: true, ownerName: "Alice" })]}
        busyId={null}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />,
    );
    const [mine, theirs] = screen.getAllByRole("listitem");
    expect(within(theirs!).getByText("Shared by Alice")).toBeInTheDocument();
    expect(within(theirs!).queryByRole("button")).toBeNull();
    expect(within(mine!).getByText("Yours, shared with your company")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete Weekly status" }));
    expect(screen.getByText("Delete this skill for everyone?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("s1");

    await user.click(screen.getByRole("button", { name: "Edit Weekly status" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onUpdate).toHaveBeenCalledWith("s1", expect.objectContaining({ name: "Renamed", shared: true }));
  });

  it("shows an unreadable skill as such, deletable only, and says when there are none", () => {
    const { unmount } = render(<SkillList skills={[skill({ readable: false, name: "" })]} busyId={null} onUpdate={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText("This skill could not be read")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete this skill" })).toBeInTheDocument();
    unmount();
    render(<SkillList skills={[]} busyId={null} onUpdate={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText("No skills yet.")).toBeInTheDocument();
  });
});

describe("SkillPicker", () => {
  it("shows exactly what a colleague's skill will tell the agent before the run starts", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const theirs = skill({ id: "s2", mine: false, shared: true, ownerName: "Alice", instructions: "Post <b>everything</b>", tools: ["search_documents", "propose_jira_comment"] });
    const { rerender } = render(<SkillPicker skills={[theirs, skill({ id: "s3", readable: false })]} selectedId="" onSelect={onSelect} />);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["No skill", "Weekly status (from Alice)"]);
    await user.selectOptions(screen.getByLabelText("Follow a skill"), "s2");
    expect(onSelect).toHaveBeenCalledWith("s2");
    rerender(<SkillPicker skills={[theirs]} selectedId="s2" onSelect={onSelect} />);
    expect(screen.getByText("Post <b>everything</b>")).toBeInTheDocument();
    expect(screen.getByText(/Shared by Alice\. The agent will be told/)).toBeInTheDocument();
    expect(screen.getByText(/It may only: Search and read your connected tools · Propose Jira comments/)).toBeInTheDocument();
  });

  it("points to the Skills page when there are none to use", () => {
    render(<SkillPicker skills={[]} selectedId="" onSelect={vi.fn()} />);
    expect(screen.getByRole("link", { name: "skill" })).toHaveAttribute("href", "/skills");
  });
});

describe("the skills API client", () => {
  it("sends a skill id only when a run uses one, and calls the skill routes", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, _init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const data = path.startsWith("/agent-runs")
        ? { id: "r", goal: "g", status: "running", errorCode: null, automatic: false, createdAt: "x" }
        : path === "/skills" && fetchImpl.mock.calls.length === 1
          ? []
          : path.endsWith("s1") && fetchImpl.mock.calls.length === 5
            ? { deleted: true }
            : skill();
      return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as unknown as typeof fetch);
    const input = { name: "n", instructions: "i", tools: ["search_documents"], shared: false };
    await api.skills();
    await api.addSkill(input);
    await api.updateSkill("s1", input);
    await api.startAgentRun("g");
    await api.deleteSkill("s1");
    await api.startAgentRun("g", { id: "s1", updatedAt: "v1" });
    const bodies = fetchImpl.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, (init as RequestInit | undefined)?.method ?? "GET", (init as RequestInit | undefined)?.body]);
    expect(bodies.map(([path, method]) => `${method} ${path}`)).toEqual([
      "GET /skills",
      "POST /skills",
      "POST /skills/s1",
      "POST /agent-runs",
      "DELETE /skills/s1",
      "POST /agent-runs",
    ]);
    expect(JSON.parse(String(bodies[3]![2]))).toEqual({ goal: "g" });
    expect(JSON.parse(String(bodies[5]![2]))).toEqual({ goal: "g", skillId: "s1", skillVersion: "v1" });
  });
});
