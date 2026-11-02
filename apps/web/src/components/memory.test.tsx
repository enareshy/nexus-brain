import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "@/lib/api";
import { MemoryList } from "./MemoryList";

const memory = (id: string, text: string, readable = true): Memory => ({
  id,
  text,
  readable,
  createdAt: "2026-11-02T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
});

function renderList(memories: Memory[] = [memory("m1", "I'm on the Payments team")]) {
  const handlers = {
    onAdd: vi.fn(async () => true),
    onUpdate: vi.fn(async () => true),
    onDelete: vi.fn(),
  };
  render(<MemoryList memories={memories} busyId={null} {...handlers} />);
  return handlers;
}

describe("MemoryList", () => {
  it("adds a memory as one trimmed line and clears the box", async () => {
    const user = userEvent.setup();
    const { onAdd } = renderList([]);
    expect(screen.getByText(/Brain only remembers what you add here/)).toBeInTheDocument();
    const box = screen.getByLabelText("Something for Brain to remember");
    await user.type(box, "  Keep answers short  ");
    await user.click(screen.getByRole("button", { name: "Remember" }));
    expect(onAdd).toHaveBeenCalledWith("Keep answers short");
    expect(box).toHaveValue("");
  });

  it("does not add an empty memory", async () => {
    renderList([]);
    expect(screen.getByRole("button", { name: "Remember" })).toBeDisabled();
  });

  it("edits a memory in place", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderList();
    await user.click(screen.getByRole("button", { name: "Edit: I'm on the Payments team" }));
    const field = screen.getByLabelText("Edit memory");
    await user.clear(field);
    await user.type(field, "I'm on the Billing team");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onUpdate).toHaveBeenCalledWith("m1", "I'm on the Billing team");
    expect(screen.queryByLabelText("Edit memory")).toBeNull();
  });

  it("lets the person delete a memory that cannot be read, but not edit it", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderList([memory("bad", "", false)]);
    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete unreadable memory" }));
    expect(onDelete).toHaveBeenCalledWith("bad");
  });

  it("deletes a memory", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderList();
    await user.click(screen.getByRole("button", { name: "Delete: I'm on the Payments team" }));
    expect(onDelete).toHaveBeenCalledWith("m1");
  });
});
