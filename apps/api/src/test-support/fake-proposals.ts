import type { ProposalsApi } from "../proposals/proposals.service.js";

function unused(): never {
  throw new Error("Proposals are not used in this test");
}

/** For tests that build the whole app but do not exercise proposals. */
export const unusedProposals: ProposalsApi = {
  targets: unused,
  list: unused,
  propose: unused,
  approve: unused,
  reject: unused,
};
