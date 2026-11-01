// DEV ONLY CLI until the web UI exists. Logs in a seed user via local Keycloak and calls the API.
//   node scripts/dev-brain.mjs connect  <user> <server>   -> prints the consent URL; stands in for the web
//                                                            app on WEB_APP_URL to finish the connection
//   node scripts/dev-brain.mjs status   <user>
//   node scripts/dev-brain.mjs tools    <user> <server>   -> writes docs/adr/0001-<server>-tools.json
//   node scripts/dev-brain.mjs search   <user> "<query>"
//   node scripts/dev-brain.mjs disconnect <user> <server>
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const KEYCLOAK = process.env.SMOKE_KEYCLOAK ?? "http://localhost:8081/realms/brain";
const API = process.env.SMOKE_API ?? "http://127.0.0.1:3001";
const WEB_APP = process.env.WEB_APP_URL ?? "http://localhost:3000";
const CONSENT_TIMEOUT_MS = 10 * 60 * 1000;
const PASSWORD = process.env.SMOKE_PASSWORD ?? "dev-password"; // matches infra/keycloak/brain-realm.json

const [command, user, arg] = process.argv.slice(2);
if (!command || !user) {
  console.error("usage: dev-brain.mjs <connect|status|tools|search|disconnect> <user> [server|query]");
  process.exit(2);
}

async function login(username) {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "brain-dev-cli",
      username,
      password: PASSWORD,
      scope: "openid",
    }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: ${res.status}`);
  return (await res.json()).access_token;
}

async function call(method, path, token, payload) {
  const headers = { authorization: `Bearer ${token}` };
  if (payload) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`${method} ${path} -> ${res.status} ${body.error?.code}: ${body.error?.message}`);
  return body.data;
}

/**
 * Plays the web app's part: listens on WEB_APP_URL for /connections/complete, then
 * finishes the connection with the signed-in user's token (login-CSRF safe flow).
 */
function awaitConsentRedirect() {
  const listenUrl = new URL(WEB_APP);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", listenUrl);
      if (url.pathname !== "/connections/complete") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("You can close this tab and return to the terminal.");
      server.close();
      clearTimeout(timer);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) reject(new Error("consent was declined or failed"));
      else resolve({ code, state });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for consent"));
    }, CONSENT_TIMEOUT_MS);
    server.on("error", reject);
    server.listen(Number(listenUrl.port || 80), listenUrl.hostname);
  });
}

const token = await login(user);
switch (command) {
  case "connect": {
    const redirect = awaitConsentRedirect();
    const { authorizationUrl } = await call("POST", `/connections/${arg}/authorize`, token);
    console.log("Open this URL in your browser and approve access (valid for 10 minutes):\n");
    console.log(authorizationUrl);
    console.log(`\nWaiting for the redirect on ${WEB_APP}/connections/complete ...`);
    const { code, state } = await redirect;
    const done = await call("POST", "/connections/complete", token, { code, state });
    console.log(`Connected ${done.serverId} for ${user}.`);
    break;
  }
  case "status":
    console.table(await call("GET", "/connections", token));
    break;
  case "tools": {
    const tools = await call("GET", `/connections/${arg}/tools`, token);
    mkdirSync("docs/adr", { recursive: true });
    const file = `docs/adr/0001-${arg}-tools.json`;
    writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), server: arg, tools }, null, 2));
    console.log(`${tools.length} tools written to ${file}:`);
    for (const t of tools) console.log(` - ${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : ""}`);
    break;
  }
  case "search": {
    const result = await call("GET", `/search?q=${encodeURIComponent(arg ?? "")}`, token);
    console.table(result.sources);
    for (const h of result.hits) console.log(`[${h.serverId}] ${h.externalId}  ${h.title}\n    ${h.url}`);
    break;
  }
  case "disconnect":
    console.log(await call("DELETE", `/connections/${arg}`, token));
    break;
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
