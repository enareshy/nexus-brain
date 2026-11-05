import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Person } from "@/lib/api";
import { PeopleList } from "./PeopleList";

const person = (over: Partial<Person>): Person => ({
  id: "p1",
  email: "bob@acme.example",
  displayName: "Bob",
  role: "member",
  active: true,
  deactivatedAt: null,
  erased: false,
  ...over,
});

const people = [
  person({ id: "me", displayName: "Pat", role: "admin", email: "pat@example.com" }),
  person({ id: "owner", displayName: "Alice", role: "owner", email: "alice@acme.example" }),
  person({ id: "bob" }),
  person({ id: "gina", displayName: "Gina", role: "guest", active: false, deactivatedAt: "2026-11-01T00:00:00Z" }),
];

function renderList(isOwner = false) {
  const onDeactivate = vi.fn();
  const onReactivate = vi.fn();
  render(
    <PeopleList
      people={people}
      currentUserId="me"
      isOwner={isOwner}
      busyId={null}
      onDeactivate={onDeactivate}
      onReactivate={onReactivate}
    />,
  );
  return { onDeactivate, onReactivate };
}

describe("PeopleList", () => {
  it("never offers to turn off yourself, and lets only an owner change an owner", () => {
    renderList();
    expect(screen.queryByRole("button", { name: "Turn off Pat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn off Alice" })).toBeNull();
    expect(screen.getByRole("button", { name: "Turn off Bob" })).toBeEnabled();
  });

  it("shows an owner the option for another owner", () => {
    renderList(true);
    expect(screen.getByRole("button", { name: "Turn off Alice" })).toBeEnabled();
  });

  it("asks for confirmation, says what will stop, and can be cancelled", async () => {
    const user = userEvent.setup();
    const { onDeactivate } = renderList();
    await user.click(screen.getByRole("button", { name: "Turn off Bob" }));
    expect(screen.getByText(/running agents are cancelled/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDeactivate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Turn off Bob" }));
    await user.click(screen.getByRole("button", { name: "Confirm turning off Bob" }));
    expect(onDeactivate).toHaveBeenCalledWith("bob");
  });

  it("marks people who are turned off and lets an admin turn them back on", async () => {
    const user = userEvent.setup();
    const { onReactivate } = renderList();
    expect(screen.getByText("Turned off")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn Gina back on" }));
    expect(onReactivate).toHaveBeenCalledWith("gina");
  });
});

describe("erasing someone (FR-ADM-03)", () => {
  it("offers erase only for someone turned off, explains it, and asks before doing it", async () => {
    const user = userEvent.setup();
    const onErase = vi.fn();
    render(
      <PeopleList
        people={[person({ id: "p1", active: false, deactivatedAt: "t" }), person({ id: "p2", displayName: "Alice" })]}
        currentUserId="me"
        isOwner={false}
        busyId={null}
        onDeactivate={vi.fn()}
        onReactivate={vi.fn()}
        onErase={onErase}
      />,
    );
    expect(screen.queryByRole("button", { name: "Erase Alice" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Erase Bob" }));
    expect(onErase).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm erasing Bob" }));
    expect(onErase).toHaveBeenCalledWith("p1");
  });

  it("shows an erased person as erased, with nothing left to do", () => {
    render(
      <PeopleList
        people={[person({ displayName: "Erased person", active: false, deactivatedAt: "t", erased: true })]}
        currentUserId="me"
        isOwner
        busyId={null}
        onDeactivate={vi.fn()}
        onReactivate={vi.fn()}
        onErase={vi.fn()}
      />,
    );
    expect(screen.getByText("Erased")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
