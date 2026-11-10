import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphItem } from "@/lib/api";
import { MAX_LISTED_ITEMS, WorkGraphList } from "./WorkGraphList";

const item = (itemId: string, over: Partial<GraphItem> = {}): GraphItem => ({
  serverId: "atlassian",
  itemId,
  opened: 0,
  helpful: 0,
  linkedItems: 0,
  lastSeenAt: "2026-11-09T10:00:00.000Z",
  ...over,
});

function renderList(items: GraphItem[], busyKey: string | null = null) {
  const handlers = { onForget: vi.fn(), onClear: vi.fn() };
  render(<WorkGraphList items={items} busyKey={busyKey} {...handlers} />);
  return handlers;
}

describe("WorkGraphList", () => {
  it("explains what it is when there is nothing yet", () => {
    renderList([]);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear/ })).toBeNull();
  });

  it("lists each item by service and id, with how it was used", () => {
    renderList([item("ENG-1", { opened: 2 }), item("pr-4", { serverId: "github", helpful: 1, linkedItems: 2 })]);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("ENG-1")).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/atlassian/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Opened 2 times/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Helpful in 1 answer, cited with 2 other items/)).toBeInTheDocument();
  });

  it("renders ids from services as plain text", () => {
    const { container } = render(
      <WorkGraphList items={[item("<img src=x onerror=alert(1)>")]} busyKey={null} onForget={vi.fn()} onClear={vi.fn()} />,
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("forgets one item, naming it for screen readers", async () => {
    const user = userEvent.setup();
    const { onForget } = renderList([item("ENG-1"), item("ENG-2")]);
    await user.click(screen.getByRole("button", { name: "Forget atlassian ENG-2" }));
    expect(onForget).toHaveBeenCalledWith({ serverId: "atlassian", itemId: "ENG-2" });
  });

  it("asks before clearing everything, moving focus to the choice, and can be cancelled", async () => {
    const user = userEvent.setup();
    const { onClear } = renderList([item("ENG-1"), item("ENG-2")]);
    await user.click(screen.getByRole("button", { name: "Clear all of it" }));
    expect(screen.getByRole("group", { name: "Clear what Brain learned" })).toHaveTextContent(/Clear everything Brain learned/);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClear).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear all of it" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("disables the item being forgotten while it goes", () => {
    renderList([item("ENG-1")], "atlassian:ENG-1");
    expect(screen.getByRole("button", { name: "Forget atlassian ENG-1" })).toBeDisabled();
  });

  it("says when only the most recent items are shown, and that heavy use is at least 20", () => {
    renderList(Array.from({ length: MAX_LISTED_ITEMS }, (_, i) => item(`ENG-${i}`, { opened: i === 0 ? 20 : 1 })));
    expect(screen.getByText(/Showing the 200 most recent/)).toBeInTheDocument();
    expect(screen.getByText(/Opened 20\+ times/)).toBeInTheDocument();
  });
});
