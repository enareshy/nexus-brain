# ADR 0003: Brain's own MCP server

Status: accepted, 2026-11-02. Implements FR-MCP-01 and FR-MCP-03, with the gaps below.

## Decision
`POST /mcp` on the API lets an AI tool work in Brain as one signed-in person. Each request is authenticated alone and nothing is kept between requests.

## Tools
`search_documents`, `get_item`, `list_jira_projects`, `propose_jira_issue`, `propose_jira_update`, `propose_jira_comment`, `get_proposal`. The list is fixed.

"Create or update" in FR-MCP-01 is met by proposing. A proposal waits for the person in the Changes page, and an MCP token cannot approve it. This keeps the approval rule (FR-WR) the same for people, agents and outside tools.

## Sign-in
- The endpoint accepts only tokens with the audience `brain-mcp`, and the web API accepts only `brain-api`. Startup fails if the two settings match.
- A client without a token gets a 401 pointing to `/.well-known/oauth-protected-resource/mcp`, which names the sign-in server.
- The Keycloak client `brain-mcp-tools` is public, requires PKCE S256 and asks the person for consent.
- Tokens for connected services stay in the vault and are never passed to or from the caller.
- Requests with an `Origin` header are refused, so a web page cannot use someone's browser to reach this. Batches are refused, so each call counts against the rate limit.
- Every call is audited with the person, the app, the tool, a hash of the input and the outcome.

## To connect an AI tool (local)
Server URL `http://127.0.0.1:3001/mcp`, OAuth client ID `brain-mcp-tools`, no client secret, and a redirect to a local port.

An existing local Keycloak does not re-import the realm file, so add the two new clients (`brain-mcp`, `brain-mcp-tools`) through its admin API or recreate the container.

## Gaps
- **Protocol version.** FR-MCP-01 targets 2026-07-28. The latest SDK, 1.32.2, supports up to 2025-11-25, so that is what this serves. Requests are already stateless, which is the main change that revision asks for.
- **Automatic client registration does not work.** Keycloak advertises a registration endpoint, but it refuses anonymous registrations by default, and a client registered that way would not get the `brain-mcp` audience. Each tool must be given the client ID. Fixing this means choosing a production sign-in setup.
- **One shared client.** Audit shows `brain-mcp-tools` for every tool, not which tool it was. The redirect allows any local port on 127.0.0.1 and localhost, so any program on the person's machine could complete a sign-in if the person consents. Replace this with one registered client per tool before production.
- **Tested with the MCP SDK client and a scripted sign-in,** not with a real AI product.
- **Reach of a token.** A connected tool can read anything the person can read in their connected services. Consent is the only control; there are no narrower scopes yet.
- **Origin of a proposal.** The Changes page does not yet say that a proposal came from an outside tool. The audit log does.
- **Plan limits (FR-MCP-04)** are not built. The general limit of 120 requests a minute per token applies.
