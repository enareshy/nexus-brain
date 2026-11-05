import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/api";
import { keptFor, RetentionForm } from "./RetentionForm";

const keepAll = { conversationDays: null, agentRunDays: null };

describe("RetentionForm (FR-ADM-03)", () => {
  it("asks before shortening how long data is kept, then saves the days", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => true);
    render(<RetentionForm retention={keepAll} isSaving={false} onSave={onSave} />);
    await user.type(screen.getByLabelText("Keep chats for (days)"), "90");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", { name: "Confirm removing data" });
    expect(dialog).toHaveAccessibleDescription(/^Chats unused for more than 90 days will be removed for everyone .*cannot be brought back\./);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByLabelText("Keep chats for (days)")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove older data" }));
    expect(onSave).toHaveBeenCalledWith({ conversationDays: 90, agentRunDays: null });
  });

  it("saves without asking when nothing more would be removed, and can be cancelled", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => true);
    const { unmount } = render(<RetentionForm retention={{ conversationDays: 30, agentRunDays: 7 }} isSaving={false} onSave={onSave} />);
    await user.clear(screen.getByLabelText("Keep chats for (days)"));
    await user.type(screen.getByLabelText("Keep chats for (days)"), "60");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ conversationDays: 60, agentRunDays: 7 });
    unmount();

    render(<RetentionForm retention={{ conversationDays: 30, agentRunDays: null }} isSaving={false} onSave={onSave} />);
    await user.type(screen.getByLabelText("Keep finished agent runs for (days)"), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("refuses days that are not whole numbers from 1 to 3,650", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RetentionForm retention={keepAll} isSaving={false} onSave={onSave} />);
    for (const text of ["0", "3651", "1.5", "ten"]) {
      await user.clear(screen.getByLabelText("Keep chats for (days)"));
      await user.type(screen.getByLabelText("Keep chats for (days)"), text);
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent(/whole number of days/);
    }
    expect(onSave).not.toHaveBeenCalled();
  });

  it("says what each setting means in words", () => {
    expect(keptFor(null)).toBe("kept until people delete them");
    expect(keptFor(1)).toBe("removed 1 day after they were last used");
    expect(keptFor(30)).toBe("removed 30 days after they were last used");
  });
});

describe("the data API client", () => {
  it("reads and saves retention, and downloads the person's export", async () => {
    const replies = [keepAll, { conversationDays: 30, agentRunDays: null }, { exportedAt: "t", memories: [] }];
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, data: replies.shift() }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as unknown as typeof fetch);
    expect(await api.retention()).toEqual(keepAll);
    expect(await api.setRetention({ conversationDays: 30, agentRunDays: null })).toEqual({ conversationDays: 30, agentRunDays: null });
    expect(await api.exportMyData()).toEqual({ exportedAt: "t", memories: [] });
    expect(fetchImpl.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`)).toEqual([
      "GET /data/retention",
      "POST /admin/retention",
      "GET /me/export",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).toEqual({ conversationDays: 30, agentRunDays: null });
  });
});
