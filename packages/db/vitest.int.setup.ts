import { ensureTestDatabase, testDatabaseUrls } from "./src/test-database.js";

export default async function setup(): Promise<void> {
  await ensureTestDatabase(testDatabaseUrls().ownerUrl);
}
