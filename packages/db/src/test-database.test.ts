import { describe, expect, it } from "vitest";
import { ensureTestDatabase, testDatabaseEnv, testDatabaseUrls } from "./test-database.js";

describe("testDatabaseUrls", () => {
  it("defaults to brain_test on localhost when nothing is set", () => {
    expect(testDatabaseUrls({})).toEqual({
      ownerUrl: "postgres://brain:brain@localhost:5432/brain_test",
      appUrl: "postgres://brain_app:brain_app@localhost:5432/brain_test",
    });
  });

  it("adds _test to the dev database name, never reusing the dev database", () => {
    const urls = testDatabaseUrls({
      DATABASE_URL: "postgres://o:p@db:5432/brain",
      DATABASE_APP_ROLE_URL: "postgres://a:p@db:5432/brain",
    });
    expect(urls.ownerUrl).toBe("postgres://o:p@db:5432/brain_test");
    expect(urls.appUrl).toBe("postgres://a:p@db:5432/brain_test");
  });

  it("prefers TEST_* URLs and keeps a name that already ends in _test", () => {
    const env = testDatabaseEnv({
      DATABASE_URL: "postgres://o:p@db/brain",
      TEST_DATABASE_URL: "postgres://o:p@db/ci_test",
      TEST_DATABASE_APP_ROLE_URL: "postgres://a:p@db/ci_test",
    });
    expect(env).toEqual({ DATABASE_URL: "postgres://o:p@db/ci_test", DATABASE_APP_ROLE_URL: "postgres://a:p@db/ci_test" });
  });

  it("rejects URLs without a database name or naming two databases", () => {
    expect(() => testDatabaseUrls({ TEST_DATABASE_URL: "postgres://o:p@db" })).toThrow(/no database name/);
    expect(() => testDatabaseUrls({ TEST_DATABASE_URL: "postgres://o:p@db/a_test", TEST_DATABASE_APP_ROLE_URL: "postgres://a:p@db/b_test" })).toThrow(
      /same database/,
    );
  });
});

describe("ensureTestDatabase", () => {
  it("refuses a database that is not a test database, before connecting", async () => {
    await expect(ensureTestDatabase("postgres://o:p@127.0.0.1:1/brain")).rejects.toThrow(/Refusing/);
  });
});
