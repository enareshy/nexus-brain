// DEV ONLY smoke test: logs in seed users through local Keycloak and calls the API.
// Usage: node scripts/smoke-login.mjs   (needs `pnpm infra:up`, `pnpm db:seed`, `pnpm dev`)
const KEYCLOAK = process.env.SMOKE_KEYCLOAK ?? "http://localhost:8081/realms/brain";
const API = process.env.SMOKE_API ?? "http://127.0.0.1:3001";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "dev-password"; // matches infra/keycloak/brain-realm.json

async function token(username) {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "brain-dev-cli",
      username,
      password: PASSWORD,
      scope: "openid",
    }),
  });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function me(accessToken, extraHeaders = {}) {
  const res = await fetch(`${API}/me`, {
    headers: { authorization: `Bearer ${accessToken}`, ...extraHeaders },
  });
  return { status: res.status, body: await res.json() };
}

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!condition) failures += 1;
}

const health = await fetch(`${API}/health`).then((r) => r.status);
check("GET /health is public", health === 200, health);

const noAuth = await fetch(`${API}/me`);
check("GET /me without token is 401", noAuth.status === 401, noAuth.status);

const patAcme = await me(await token("pat.acme"));
check("pat.acme resolves to Acme", patAcme.body.data?.tenantId === "0a000000-0000-4000-8000-000000000001", patAcme);
check("pat.acme has engineering group", patAcme.body.data?.principals?.includes("group:0a000000-0000-4000-8000-0000000000e1"), patAcme);

const patGlobex = await me(await token("pat.globex"), { "x-tenant-id": "0a000000-0000-4000-8000-000000000001" });
check("pat.globex resolves to Globex despite spoofed header", patGlobex.body.data?.tenantId === "0b000000-0000-4000-8000-000000000001", patGlobex);
check("same email, different user IDs across tenants", patGlobex.body.data?.userId !== patAcme.body.data?.userId, { patAcme, patGlobex });

const gina = await me(await token("gina"));
check(
  "guest gina has only her user principal (no groups, no tenant:all)",
  gina.body.data?.role === "guest" && JSON.stringify(gina.body.data.principals) === JSON.stringify([`user:${gina.body.data.userId}`]),
  gina,
);

const tampered = await me(`${(await token("bob")).slice(0, -4)}AAAA`);
check("tampered token is 401", tampered.status === 401, tampered);

process.exit(failures === 0 ? 0 : 1);
