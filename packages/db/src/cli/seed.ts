import pg from "pg";
import { loadDbEnv } from "../config.js";
import { seed } from "../seed.js";

const env = loadDbEnv();
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  await seed(client);
  process.stdout.write("Seeded demo tenants Acme and Globex\n");
} finally {
  await client.end();
}
