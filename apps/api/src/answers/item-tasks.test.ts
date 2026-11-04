import { describe, expect, it } from "vitest";
import { canHaveSubtasks, itemTaskRequest, MAX_SUBTASKS, parseSubtasks } from "./item-tasks.js";

describe("parseSubtasks", () => {
  it("takes list lines in any common bullet style, as single plain lines", () => {
    expect(parseSubtasks("Here you go:\n- One\n* Two\n• Three\n4. Four\n5) Five\nnot a bullet")).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });

  it("removes control and invisible characters, empties and repeats, and caps the count and length", () => {
    expect(parseSubtasks("- a\u0000b‮c\n-   \n- a b c")).toEqual(["a b c"]);
    expect(parseSubtasks(`- ${"x".repeat(500)}`)[0]).toHaveLength(200);
    const many = Array.from({ length: 20 }, (_, i) => `- Task ${i}`).join("\n");
    expect(parseSubtasks(many)).toHaveLength(MAX_SUBTASKS);
  });
});

describe("item tasks", () => {
  it("puts the person's draft request in their own question", () => {
    expect(itemTaskRequest({ kind: "draft", request: "a status update" })).toContain("a status update");
    expect(itemTaskRequest({ kind: "summary" })).toMatch(/^Summarise/);
    expect(itemTaskRequest({ kind: "subtasks" })).toContain(`up to ${MAX_SUBTASKS} subtasks`);
  });

  it("allows subtasks only under a Jira issue", () => {
    const issue = { serverId: "atlassian", externalId: "ENG-1", url: "https://a.atlassian.net/browse/ENG-1" };
    expect(canHaveSubtasks(issue)).toBe(true);
    expect(canHaveSubtasks({ ...issue, externalId: "confluence:9" })).toBe(false);
    expect(canHaveSubtasks({ ...issue, serverId: "slack" })).toBe(false);
  });
});
