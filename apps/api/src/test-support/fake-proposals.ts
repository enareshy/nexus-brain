import type { AgentsApi } from "../agents/agents.service.js";
import type { AuditApi } from "../admin/audit.service.js";
import type { ConversationsApi } from "../conversations/conversations.service.js";
import type { ProposalsApi } from "../proposals/proposals.service.js";

function unused(): never {
  throw new Error("Proposals are not used in this test");
}

/** For tests that build the whole app but do not exercise agents. */
export const unusedAgents: AgentsApi = { start: unused, resume: unused, list: unused, get: unused, cancel: unused };

/** For tests that build the whole app but do not exercise conversations. */
export const unusedConversations: ConversationsApi = { list: unused, get: unused, remove: unused, feedback: unused };

/** For tests that build the whole app but do not exercise the audit trail. */
export const unusedAudit: AuditApi = { list: unused };

/** For tests that build the whole app but do not exercise proposals. */
export const unusedProposals: ProposalsApi = {
  targets: unused,
  list: unused,
  get: unused,
  propose: unused,
  approve: unused,
  reject: unused,
};
