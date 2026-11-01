import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0380_builtin_routine_responsibility.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("built-in routine responsibility migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("repairs only proven producer owners and appends an idempotent current revision", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-builtin-routine-responsibility-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    const ids = {
      configured: randomUUID(),
      fallback: randomUUID(),
      inactiveDefault: randomUUID(),
      ordinary: randomUUID(),
      alreadyReal: randomUUID(),
      configuredAgent: randomUUID(),
      fallbackAgent: randomUUID(),
      inactiveAgent: randomUUID(),
      ordinaryAgent: randomUUID(),
      alreadyRealAgent: randomUUID(),
      configuredRoutine: randomUUID(),
      fallbackRoutine: randomUUID(),
      inactiveRoutine: randomUUID(),
      ordinaryRoutine: randomUUID(),
      alreadyRealRoutine: randomUUID(),
      configuredTrigger: randomUUID(),
      historicalRevision: randomUUID(),
      fallbackHistoricalRevision: randomUUID(),
      inactiveHistoricalRevision: randomUUID(),
      run: randomUUID(),
    };
    const companies = [
      { id: ids.configured, prefix: "BRC", defaultUser: "configured-user" },
      { id: ids.fallback, prefix: "BRF", defaultUser: null },
      { id: ids.inactiveDefault, prefix: "BRI", defaultUser: "inactive-user" },
      { id: ids.ordinary, prefix: "BRO", defaultUser: null },
      { id: ids.alreadyReal, prefix: "BRR", defaultUser: null },
    ];
    for (const company of companies) {
      await sql`INSERT INTO "companies" ("id", "name", "issue_prefix", "default_responsible_user_id")
        VALUES (${company.id}, ${company.prefix}, ${company.prefix}, ${company.defaultUser})`;
    }
    const memberships = [
      [ids.configured, "configured-user", "operator", "2026-01-01T00:00:00Z"],
      [ids.fallback, "later-owner", "owner", "2026-01-02T00:00:00Z"],
      [ids.fallback, "first-owner", "owner", "2026-01-01T00:00:00Z"],
      [ids.inactiveDefault, "inactive-user", "owner", "2026-01-01T00:00:00Z"],
      [ids.inactiveDefault, "other-owner", "owner", "2026-01-02T00:00:00Z"],
      [ids.ordinary, "inactive-user", "operator", "2026-01-03T00:00:00Z"],
    ] as const;
    for (const [companyId, userId, role, createdAt] of memberships) {
      await sql`INSERT INTO "company_memberships" ("company_id", "principal_type", "principal_id", "status", "membership_role", "created_at")
        VALUES (${companyId}, 'user', ${userId}, 'active', ${role}, ${createdAt})`;
    }
    await sql`UPDATE "company_memberships" SET "status" = 'inactive'
      WHERE "company_id" = ${ids.inactiveDefault} AND "principal_id" = 'inactive-user'`;

    const agentRows = [
      [ids.configuredAgent, ids.configured, "reflection-coach"],
      [ids.fallbackAgent, ids.fallback, "summarizer"],
      [ids.inactiveAgent, ids.inactiveDefault, "reflection-coach"],
      [ids.ordinaryAgent, ids.ordinary, "reflection-coach"],
      [ids.alreadyRealAgent, ids.alreadyReal, "summarizer"],
    ] as const;
    for (const [agentId, companyId, key] of agentRows) {
      await sql`INSERT INTO "agents" ("id", "company_id", "name", "status", "metadata")
        VALUES (${agentId}, ${companyId}, ${key}, 'idle', ${sql.json({ paperclipBuiltInAgent: { key, featureKeys: [key] } })})`;
    }

    const routines = [
      [ids.configuredRoutine, ids.configured, ids.configuredAgent, "reflection-coach:recent-agent-reflection", "built-in-bundles"],
      [ids.fallbackRoutine, ids.fallback, ids.fallbackAgent, "summarizer:refresh-stale-summaries", "built-in-bundles"],
      [ids.inactiveRoutine, ids.inactiveDefault, ids.inactiveAgent, "reflection-coach:recent-agent-reflection", "built-in-bundles"],
      [ids.ordinaryRoutine, ids.ordinary, ids.ordinaryAgent, null, "ordinary-owner"],
      [ids.alreadyRealRoutine, ids.alreadyReal, ids.alreadyRealAgent, "summarizer:refresh-stale-summaries", "already-real-owner"],
    ] as const;
    for (const [routineId, companyId, agentId, originId, responsibleUserId] of routines) {
      await sql`INSERT INTO "routines" (
          "id", "company_id", "title", "assignee_agent_id", "status", "origin_kind", "origin_id",
          "responsible_user_id", "created_by_user_id", "created_at", "updated_at"
        ) VALUES (
          ${routineId}, ${companyId}, 'Routine ' || ${routineId}, ${agentId}, 'paused',
          ${originId ? "built_in_agent_bundle" : "manual"}, ${originId}, ${responsibleUserId}, 'built-in-bundles', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        )`;
    }
    await sql`INSERT INTO "routine_triggers" ("id", "company_id", "routine_id", "kind", "enabled", "cron_expression", "timezone")
      VALUES (${ids.configuredTrigger}, ${ids.configured}, ${ids.configuredRoutine}, 'schedule', false, '0 9 * * 1', 'UTC')`;
    await sql`INSERT INTO "routine_revisions" (
        "id", "company_id", "routine_id", "revision_number", "title", "snapshot", "change_summary", "responsible_user_id", "created_at"
      ) SELECT ${ids.historicalRevision}, r."company_id", r."id", 1, r."title",
        jsonb_build_object('version', 1, 'routine', jsonb_build_object('id', r."id", 'responsibleUserId', r."responsible_user_id"), 'triggers', '[]'::jsonb),
        'Historical producer revision', r."responsible_user_id", '2026-01-01T00:00:00Z'
      FROM "routines" r WHERE r."id" = ${ids.configuredRoutine}`;
    await sql`UPDATE "routines" SET "latest_revision_id" = ${ids.historicalRevision}, "latest_revision_number" = 1
      WHERE "id" = ${ids.configuredRoutine}`;
    for (const [routineId, revisionId] of [
      [ids.fallbackRoutine, ids.fallbackHistoricalRevision],
      [ids.inactiveRoutine, ids.inactiveHistoricalRevision],
    ] as const) {
      await sql`INSERT INTO "routine_revisions" (
          "id", "company_id", "routine_id", "revision_number", "title", "snapshot", "change_summary", "responsible_user_id", "created_at"
        ) SELECT ${revisionId}, r."company_id", r."id", 1, r."title",
          jsonb_build_object('version', 1, 'routine', jsonb_build_object('id', r."id", 'responsibleUserId', r."responsible_user_id"), 'triggers', '[]'::jsonb),
          'Historical producer revision', r."responsible_user_id", '2026-01-01T00:00:00Z'
        FROM "routines" r WHERE r."id" = ${routineId}`;
      await sql`UPDATE "routines" SET "latest_revision_id" = ${revisionId}, "latest_revision_number" = 1
        WHERE "id" = ${routineId}`;
    }
    await sql`INSERT INTO "routine_runs" ("id", "company_id", "routine_id", "source", "status", "routine_revision_id", "responsible_user_id")
      VALUES (${ids.run}, ${ids.configured}, ${ids.configuredRoutine}, 'manual', 'queued', ${ids.historicalRevision}, 'built-in-bundles')`;

    const routineTimestampsBefore = await sql<{ id: string; updated_at: Date }[]>`
      SELECT "id", "updated_at" FROM "routines"
      WHERE "id" IN (${ids.configuredRoutine}, ${ids.fallbackRoutine}, ${ids.inactiveRoutine}, ${ids.ordinaryRoutine}, ${ids.alreadyRealRoutine})
      ORDER BY "id"
    `;
    const [routineBefore] = await sql`SELECT to_jsonb(r) - ARRAY['responsible_user_id', 'latest_revision_id', 'latest_revision_number'] AS stable
      FROM "routines" r WHERE r."id" = ${ids.configuredRoutine}`;
    const [triggerBefore] = await sql`SELECT * FROM "routine_triggers" WHERE "id" = ${ids.configuredTrigger}`;
    const [revisionBefore] = await sql`SELECT * FROM "routine_revisions" WHERE "id" = ${ids.historicalRevision}`;
    const [runBefore] = await sql`SELECT * FROM "routine_runs" WHERE "id" = ${ids.run}`;

    const [migrationStartedAt] = await sql<{ now: Date }[]>`SELECT now() AS now`;
    await applyPendingMigrations(database.connectionString);

    const results = await sql<{ id: string; responsible_user_id: string; latest_revision_number: number; latest_revision_id: string; updated_at: Date }[]>`
      SELECT "id", "responsible_user_id", "latest_revision_number", "latest_revision_id", "updated_at"
      FROM "routines" WHERE "id" IN (${ids.configuredRoutine}, ${ids.fallbackRoutine}, ${ids.inactiveRoutine}, ${ids.ordinaryRoutine}, ${ids.alreadyRealRoutine})
    `;
    const byId = new Map(results.map((row) => [row.id, row]));
    expect(byId.get(ids.configuredRoutine)).toMatchObject({ responsible_user_id: "configured-user", latest_revision_number: 2 });
    expect(byId.get(ids.fallbackRoutine)).toMatchObject({ responsible_user_id: "first-owner", latest_revision_number: 2 });
    expect(byId.get(ids.inactiveRoutine)).toMatchObject({ responsible_user_id: "built-in-bundles", latest_revision_number: 1 });
    expect(byId.get(ids.ordinaryRoutine)).toMatchObject({ responsible_user_id: "ordinary-owner", latest_revision_number: 1 });
    expect(byId.get(ids.alreadyRealRoutine)).toMatchObject({ responsible_user_id: "already-real-owner", latest_revision_number: 1 });
    expect(results.map(({ id, updated_at }) => ({ id, updated_at })).sort((left, right) => left.id.localeCompare(right.id)))
      .toEqual(routineTimestampsBefore);

    const [routineAfter] = await sql`SELECT to_jsonb(r) - ARRAY['responsible_user_id', 'latest_revision_id', 'latest_revision_number'] AS stable
      FROM "routines" r WHERE r."id" = ${ids.configuredRoutine}`;
    expect(routineAfter!.stable).toEqual(routineBefore!.stable);
    const [triggerAfter] = await sql`SELECT * FROM "routine_triggers" WHERE "id" = ${ids.configuredTrigger}`;
    expect(triggerAfter).toEqual(triggerBefore);
    const [revisionAfter] = await sql`SELECT * FROM "routine_revisions" WHERE "id" = ${ids.historicalRevision}`;
    expect(revisionAfter).toEqual(revisionBefore);
    const [runAfter] = await sql`SELECT * FROM "routine_runs" WHERE "id" = ${ids.run}`;
    expect(runAfter).toEqual(runBefore);

    const newRevisions = await sql<{ revision_number: number; responsible_user_id: string; snapshot: Record<string, unknown>; created_by_user_id: string | null; created_at: Date }[]>`
      SELECT "revision_number", "responsible_user_id", "snapshot", "created_by_user_id", "created_at"
      FROM "routine_revisions" WHERE "routine_id" = ${ids.configuredRoutine} ORDER BY "revision_number"
    `;
    expect(newRevisions).toHaveLength(2);
    expect(newRevisions[1]).toMatchObject({
      revision_number: 2,
      responsible_user_id: "configured-user",
      created_by_user_id: null,
      snapshot: { version: 1, routine: { id: ids.configuredRoutine, responsibleUserId: "configured-user" } },
    });
    expect(newRevisions[1]!.created_at.getTime()).toBeGreaterThanOrEqual(migrationStartedAt!.now.getTime());
    expect(byId.get(ids.configuredRoutine)!.latest_revision_id).not.toBe(ids.historicalRevision);

    const routineTimestampsBeforeReplay = await sql<{ id: string; updated_at: Date }[]>`
      SELECT "id", "updated_at" FROM "routines"
      WHERE "id" IN (${ids.configuredRoutine}, ${ids.fallbackRoutine}, ${ids.inactiveRoutine}, ${ids.ordinaryRoutine}, ${ids.alreadyRealRoutine})
      ORDER BY "id"
    `;
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await applyPendingMigrations(database.connectionString);
    const revisionsAfterReplay = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM "routine_revisions" WHERE "routine_id" = ${ids.configuredRoutine}`;
    expect(revisionsAfterReplay[0]!.count).toBe("2");
    const routineTimestampsAfterReplay = await sql<{ id: string; updated_at: Date }[]>`
      SELECT "id", "updated_at" FROM "routines"
      WHERE "id" IN (${ids.configuredRoutine}, ${ids.fallbackRoutine}, ${ids.inactiveRoutine}, ${ids.ordinaryRoutine}, ${ids.alreadyRealRoutine})
      ORDER BY "id"
    `;
    expect(routineTimestampsAfterReplay).toEqual(routineTimestampsBeforeReplay);
  }, 30_000);
});
