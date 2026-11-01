// Demo data: two tenants with one person ("Pat") in both, to exercise isolation.
// User `externalSubject` values equal the Keycloak user IDs in infra/keycloak/brain-realm.json.

export const TENANTS = {
  acme: { id: "0a000000-0000-4000-8000-000000000001", name: "Acme Corp" },
  globex: { id: "0b000000-0000-4000-8000-000000000001", name: "Globex Inc" },
} as const;

export const USERS = [
  { key: "alice", id: "0a000000-0000-4000-8000-0000000000a1", tenant: "acme", email: "alice@acme.example", displayName: "Alice (Acme owner)", role: "owner", subject: "5a000000-0000-4000-8000-0000000000a1" },
  { key: "bob", id: "0a000000-0000-4000-8000-0000000000a2", tenant: "acme", email: "bob@acme.example", displayName: "Bob (Acme member)", role: "member", subject: "5a000000-0000-4000-8000-0000000000a2" },
  { key: "gina", id: "0a000000-0000-4000-8000-0000000000a3", tenant: "acme", email: "gina@partner.example", displayName: "Gina (Acme guest)", role: "guest", subject: "5a000000-0000-4000-8000-0000000000a3" },
  { key: "patAcme", id: "0a000000-0000-4000-8000-0000000000a4", tenant: "acme", email: "pat@example.com", displayName: "Pat (Acme)", role: "admin", subject: "5a000000-0000-4000-8000-0000000000a4" },
  { key: "patGlobex", id: "0b000000-0000-4000-8000-0000000000b1", tenant: "globex", email: "pat@example.com", displayName: "Pat (Globex)", role: "admin", subject: "5b000000-0000-4000-8000-0000000000b1" },
  { key: "gus", id: "0b000000-0000-4000-8000-0000000000b2", tenant: "globex", email: "gus@globex.example", displayName: "Gus (Globex member)", role: "member", subject: "5b000000-0000-4000-8000-0000000000b2" },
] as const;

export const GROUPS = [
  { id: "0a000000-0000-4000-8000-0000000000e1", tenant: "acme", name: "engineering", members: ["alice", "bob", "patAcme"] },
  { id: "0b000000-0000-4000-8000-0000000000e1", tenant: "globex", name: "sales", members: ["patGlobex", "gus"] },
] as const;

export type SeedUserKey = (typeof USERS)[number]["key"];

export function seedUser(key: SeedUserKey): (typeof USERS)[number] {
  const user = USERS.find((u) => u.key === key);
  if (!user) throw new Error(`Unknown seed user ${key}`);
  return user;
}
