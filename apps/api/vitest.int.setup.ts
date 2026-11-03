import { ensureTestDatabase, testDatabaseUrls } from "@brain/db/testing";

export default async function setup(): Promise<void> {
  await ensureTestDatabase(testDatabaseUrls().ownerUrl);
}
