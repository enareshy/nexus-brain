import { AppError } from "@brain/core";
import type { ConnectionsApi } from "../connections/connections.service.js";

export interface FakeConnections extends ConnectionsApi {
  readonly calls: Array<{ method: string; args: unknown[] }>;
}

/** Records calls; `complete` succeeds only for code "good". */
export function createFakeConnections(): FakeConnections {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, args: unknown[]) => calls.push({ method, args });
  return {
    calls,
    list: async (...args) => {
      record("list", args);
      return [{ serverId: "atlassian", displayName: "Atlassian", status: "not_connected", lastUsedAt: null, setup: "ready", redirectUrl: "http://127.0.0.1:3001/oauth/callback" }];
    },
    authorize: async (...args) => {
      record("authorize", args);
      return { authorizationUrl: "https://mcp.atlassian.com/v1/authorize?state=s" };
    },
    complete: async (...args) => {
      record("complete", args);
      if (args[1] !== "good") throw new AppError("VALIDATION", "bad");
      return { serverId: "atlassian" };
    },
    disconnect: async (...args) => {
      record("disconnect", args);
      return { disconnected: true, revoked: true };
    },
    saveApp: async (...args) => {
      record("saveApp", args);
      return { saved: true };
    },
    tools: async (...args) => {
      record("tools", args);
      return [];
    },
    search: async (...args) => {
      record("search", args);
      return { hits: [], sources: [] };
    },
  };
}
