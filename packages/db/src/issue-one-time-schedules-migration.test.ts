import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, ensurePostgresDatabase, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0381_issue_one_time_schedules.sql";
// Production applied these exact bytes as 0306_issue_one_time_schedules.sql
// from zay/stable-image. Applied migrations are identified by content hash
// (client.ts mapHashesToMigrationFiles), so any byte change here would make
// production run CREATE TABLE "issue_one_time_schedules" a second time.
const PRODUCTION_MIGRATION_SHA256 = "c7d87e0870397d06e44d314acd20bb90fbf6c9c92a5e42957e30b881a9887819";
// The journal `when` of the stable-image entry that production recorded.
const PRODUCTION_HISTORY_CREATED_AT = 1791300719194;
const LAST_STABLE_SHARED_MIGRATION_IDX = 305;

type JournalEntry = { idx: number; when: number; tag: string };

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function readMigration(file: string) {
  return fs.readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8");
}

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function readJournal(): JournalEntry[] {
  const raw = fs.readFileSync(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function withDatabase(connectionString: string, database: string) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

describe("issue one-time schedules migration identity", () => {
  it("keeps the bytes production applied as stable-image 0306", () => {
    expect(sha256(readMigration(MIGRATION_FILE))).toBe(PRODUCTION_MIGRATION_SHA256);
  });

  it("is journaled after the fork governance migrations", () => {
    const journal = readJournal();
    const entry = journal.find((candidate) => candidate.tag === "0381_issue_one_time_schedules");
    const governance = journal.find((candidate) => candidate.tag === "0380_builtin_routine_responsibility");
    expect(entry).toMatchObject({ idx: 381 });
    expect(entry!.when).toBeGreaterThan(governance!.when);
  });
});

describeEmbeddedPostgres("issue one-time schedules migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("applies after every upstream and governance migration on a fresh database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-one-time-schedules-fresh-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const journal = readJournal();
    const expectedHashes = journal.map((entry) => sha256(readMigration(`${entry.tag}.sql`)));
    const history = await sql<{ hash: string }[]>`
      SELECT "hash" FROM "drizzle"."__drizzle_migrations" ORDER BY "id"`;
    expect(history.map((row) => row.hash)).toEqual(expectedHashes);
    expect(history.at(-1)?.hash).toBe(PRODUCTION_MIGRATION_SHA256);

    const [trigger] = await sql<{ tgname: string }[]>`
      SELECT "tgname" FROM pg_trigger WHERE "tgname" = 'issues_invalidate_one_time_schedule_target'`;
    expect(trigger?.tgname).toBe("issues_invalidate_one_time_schedule_target");
  });

  it("upgrades a stable-image database that applied the schedule migration as 0306 without re-running it", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-one-time-schedules-production-");
    cleanups.push(database.cleanup);
    await ensurePostgresDatabase(withDatabase(database.connectionString, "postgres"), "stable_image_shape");
    const url = withDatabase(database.connectionString, "stable_image_shape");
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // Reproduce production's history: the shared prefix through 0305, then the
    // schedule migration with the stable-image journal timestamp.
    await sql`CREATE SCHEMA "drizzle"`;
    await sql`CREATE TABLE "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
    const stableHistory = [
      ...readJournal()
        .filter((entry) => entry.idx <= LAST_STABLE_SHARED_MIGRATION_IDX)
        .map((entry) => ({ file: `${entry.tag}.sql`, createdAt: entry.when, hash: null })),
      { file: MIGRATION_FILE, createdAt: PRODUCTION_HISTORY_CREATED_AT, hash: PRODUCTION_MIGRATION_SHA256 },
    ];
    for (const migration of stableHistory) {
      const content = readMigration(migration.file);
      await sql.begin(async (tx) => {
        for (const statement of content.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.unsafe(statement);
        }
        await tx`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES (${migration.hash ?? sha256(content)}, ${migration.createdAt})`;
      });
    }

    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const replacementAgentId = randomUUID();
    const scheduleId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Stable', 'STB')`;
    for (const [id, name] of [[agentId, "Scheduled"], [replacementAgentId, "Replacement"]]) {
      await sql`INSERT INTO "agents" ("id", "company_id", "name") VALUES (${id}, ${companyId}, ${name})`;
    }
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "assignee_agent_id")
      VALUES (${issueId}, ${companyId}, 'Dormant schedule', 'todo', ${agentId})`;
    await sql`INSERT INTO "issue_one_time_schedules" ("id", "company_id", "issue_id", "assignee_agent_id", "due_at", "time_zone")
      VALUES (${scheduleId}, ${companyId}, ${issueId}, ${agentId}, '2999-01-01T00:00:00Z', 'UTC')`;

    const before = await inspectMigrations(url);
    expect(before.status).toBe("needsMigrations");
    if (before.status !== "needsMigrations") throw new Error("expected pending upstream migrations");
    expect(before.pendingMigrations).not.toContain(MIGRATION_FILE);
    expect(before.pendingMigrations[0]).toBe("0306_familiar_titania.sql");

    await applyPendingMigrations(url);

    expect((await inspectMigrations(url)).status).toBe("upToDate");
    const scheduleHistory = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${PRODUCTION_MIGRATION_SHA256}`;
    expect(scheduleHistory[0]?.count).toBe(1);

    // The dormant schedule survives and the stable trigger still runs against
    // the upgraded issues table.
    await sql`UPDATE "issues" SET "assignee_agent_id" = ${replacementAgentId} WHERE "id" = ${issueId}`;
    const [schedule] = await sql<{ cancelled: boolean; cancellation_reason: string | null }[]>`
      SELECT "cancelled_at" IS NOT NULL AS cancelled, "cancellation_reason"
      FROM "issue_one_time_schedules" WHERE "id" = ${scheduleId}`;
    expect(schedule).toEqual({ cancelled: true, cancellation_reason: "Issue assignee changed after scheduling" });
  }, 240_000);
});
