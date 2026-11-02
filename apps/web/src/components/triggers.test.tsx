import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTrigger, ApiClient, Notification } from "@/lib/api";
import { AgentNotifications } from "./AgentNotifications";
import { AgentTriggers } from "./AgentTriggers";
import { NotificationBadge } from "./NotificationBadge";

const api = {
  agentTriggers: vi.fn<ApiClient["agentTriggers"]>(),
  createAgentTrigger: vi.fn<ApiClient["createAgentTrigger"]>(),
  deleteAgentTrigger: vi.fn<ApiClient["deleteAgentTrigger"]>(),
  notifications: vi.fn<ApiClient["notifications"]>(),
  markNotificationsRead: vi.fn<ApiClient["markNotificationsRead"]>(),
};
vi.mock("./AuthProvider", () => ({ useAuth: () => ({ api }) }));

const trigger = (over: Partial<AgentTrigger> = {}): AgentTrigger => ({
  id: "t1",
  kind: "schedule",
  goal: "Summarise my week",
  schedule: "daily",
  enabled: true,
  pausedReason: null,
  nextRunAt: "2026-11-03T00:00:00Z",
  ...over,
});
const note = (over: Partial<Notification> = {}): Notification => ({
  id: "n1",
  kind: "run_needs_decision",
  title: "Comment on ENG-7",
  runId: "r1",
  read: false,
  createdAt: "2026-11-02T00:00:00Z",
  ...over,
});

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe("AgentTriggers", () => {
  it("adds a schedule with the chosen timing", async () => {
    const user = userEvent.setup();
    api.agentTriggers.mockResolvedValue([]);
    api.createAgentTrigger.mockResolvedValue(trigger({ schedule: "weekly" }));
    render(<AgentTriggers />);
    await user.selectOptions(await screen.findByLabelText("When"), "weekly");
    await user.type(screen.getByLabelText("What should it do?"), "  Summarise my week ");
    await user.click(screen.getByRole("button", { name: "Add automatic agent" }));
    expect(api.createAgentTrigger).toHaveBeenCalledWith({ kind: "schedule", goal: "Summarise my week", schedule: "weekly" });
    // The option in the menu also reads "Every week", so look in the list.
    expect(await screen.findByRole("button", { name: "Remove: Summarise my week" })).toBeInTheDocument();
    expect(screen.getAllByText("Every week")).toHaveLength(2);
  });

  it("adds a Jira assignment trigger, and says plainly that runs cost money", async () => {
    const user = userEvent.setup();
    api.agentTriggers.mockResolvedValue([]);
    api.createAgentTrigger.mockResolvedValue(trigger({ kind: "jira_assigned", schedule: null }));
    render(<AgentTriggers />);
    expect(screen.getByText(/spend AI credits/)).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText("When"), "jira_assigned");
    await user.type(screen.getByLabelText("What should it do?"), "Read it");
    await user.click(screen.getByRole("button", { name: "Add automatic agent" }));
    expect(api.createAgentTrigger).toHaveBeenCalledWith({ kind: "jira_assigned", goal: "Read it" });
  });

  it("shows a paused trigger and removes one", async () => {
    const user = userEvent.setup();
    api.agentTriggers.mockResolvedValue([trigger({ kind: "jira_assigned", schedule: null, enabled: false, pausedReason: "reconnect_jira" })]);
    api.deleteAgentTrigger.mockResolvedValue({ deleted: true });
    render(<AgentTriggers />);
    expect(await screen.findByText(/Jira needs reconnecting/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove: Summarise my week" }));
    await waitFor(() => expect(screen.queryByText("Summarise my week")).not.toBeInTheDocument());
  });

  it("shows the limit message when there are too many", async () => {
    const user = userEvent.setup();
    const { ApiError } = await import("@/lib/api");
    api.agentTriggers.mockResolvedValue([]);
    api.createAgentTrigger.mockRejectedValue(new ApiError("RATE_LIMITED", "x", 429));
    render(<AgentTriggers />);
    await user.type(await screen.findByLabelText("What should it do?"), "One more");
    await user.click(screen.getByRole("button", { name: "Add automatic agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many requests/);
  });
});

describe("notifications", () => {
  it("lists unread items, opens a run, and marks everything read", async () => {
    const user = userEvent.setup();
    const onOpenRun = vi.fn();
    api.notifications.mockResolvedValue({ items: [note(), note({ id: "n2", kind: "trigger_paused", runId: null, title: "Watch Jira" }), note({ id: "n3", read: true })], unread: 2 });
    api.markNotificationsRead.mockResolvedValue({ read: true });
    render(<AgentNotifications onOpenRun={onOpenRun} />);
    expect(await screen.findByText("Needs your decision")).toBeInTheDocument();
    expect(screen.getByText(/reconnect Jira/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Comment on ENG-7" }));
    expect(onOpenRun).toHaveBeenCalledWith("r1");
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(api.markNotificationsRead).toHaveBeenCalledWith();
    await waitFor(() => expect(screen.queryByText("Watch Jira")).not.toBeInTheDocument());
  });

  it("shows nothing when there is nothing new", async () => {
    api.notifications.mockResolvedValue({ items: [], unread: 0 });
    const { container } = render(<AgentNotifications onOpenRun={vi.fn()} />);
    await waitFor(() => expect(api.notifications).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("counts unread items on the badge, and shows none for zero or an error", async () => {
    api.notifications.mockResolvedValue({ items: [], unread: 3 });
    const { unmount } = render(<NotificationBadge />);
    expect(await screen.findByText("3")).toBeInTheDocument();
    unmount();
    api.notifications.mockRejectedValue(new Error("down"));
    const { container } = render(<NotificationBadge />);
    await waitFor(() => expect(api.notifications).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });
});
