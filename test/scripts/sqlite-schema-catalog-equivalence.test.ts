import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readSqliteSchemaCatalog as readNativeCatalog } from "../../scripts/lib/sqlite-schema-catalog.mts";
import { listSqliteSchemaInputs } from "../../scripts/lib/sqlite-schema-inputs.mts";
import { readSqliteSchemaCatalog } from "../../src/infra/sqlite-schema-catalog.js";
import { collectSqliteSchemaIssues } from "../../src/infra/sqlite-schema-contract.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../src/state/openclaw-agent-db-contract.js";
import { getOpenClawAgentMigrationSchema } from "../../src/state/openclaw-agent-schema-history.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../src/state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../src/state/openclaw-state-db-contract.js";
import { getOpenClawStateRuntimeSchema } from "../../src/state/openclaw-state-schema-runtime.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import { readGeneratedSqliteCatalog } from "../../src/state/postgres-schema.generated/sqlite-catalogs.js";

const inputs = listSqliteSchemaInputs();

describe("generated SQLite schema catalogs", () => {
  it.each(inputs)("matches native catalog facts and admission for $id", ({ sql }) => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(sql);
      const generated = readGeneratedSqliteCatalog(sql);
      expect(generated).toBeDefined();
      // Native per-object PRAGMAs are independent of the batched runtime reader.
      expect(generated).toEqual(readNativeCatalog(database));
      expect(readSqliteSchemaCatalog(database)).toEqual(generated);
      expect(collectSqliteSchemaIssues(database, sql)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("covers expected definitions for fresh stores and every supported upgrade start", () => {
    const registeredSql = new Set(inputs.map(({ sql }) => sql));
    const requireCatalog = (sql: string, label: string) => {
      expect(registeredSql.has(sql), label).toBe(true);
      expect(readGeneratedSqliteCatalog(sql), label).toBeDefined();
    };
    requireCatalog(OPENCLAW_STATE_SCHEMA_SQL, "fresh state");
    requireCatalog(OPENCLAW_AGENT_SCHEMA_SQL, "fresh agent");

    // Shared-state migration preflights use the canonical definition with versioned
    // compatibility rules; creation/repair projects only the tables it may create.
    for (let version = 1; version <= OPENCLAW_STATE_SCHEMA_VERSION; version += 1) {
      requireCatalog(OPENCLAW_STATE_SCHEMA_SQL, `state v${version} preflight`);
      for (const includeAgentDeletionJournal of [false, true]) {
        requireCatalog(
          getOpenClawStateRuntimeSchema({
            includeVersionLazyAdditiveTables: version < OPENCLAW_STATE_SCHEMA_VERSION,
            includeAgentDeletionJournal,
          }),
          `state v${version} runtime, journal=${includeAgentDeletionJournal}`,
        );
      }
    }

    // v1 non-session databases remain supported; released session layouts start at v8.
    // These are the expected-definition contracts, not fabricated historical stores.
    for (const version of [
      1,
      ...Array.from({ length: OPENCLAW_AGENT_SCHEMA_VERSION - 7 }, (_, index) => index + 8),
    ]) {
      requireCatalog(getOpenClawAgentMigrationSchema(version), `agent v${version}`);
    }
  });

  it.each([
    {
      name: "DEFAULT value",
      from: "snapshot_revision INTEGER NOT NULL DEFAULT 0",
      to: "snapshot_revision INTEGER NOT NULL DEFAULT 1",
      code: "column-definition-drift",
      objectName: "session_nodes.snapshot_revision",
    },
    {
      name: "CHECK expression",
      from: "CHECK (entry_valid IN (-1, 0, 1))",
      to: "CHECK (entry_valid IN (0, 1))",
      code: "column-definition-drift",
      objectName: "session_nodes.entry_valid",
    },
    {
      name: "partial-index predicate",
      from: "WHERE label IS NOT NULL;",
      to: "WHERE label IS NULL;",
      code: "missing-or-drifted-index",
      objectName: "idx_agent_session_nodes_label",
    },
    {
      name: "trigger body",
      from: "SET snapshot_revision = snapshot_revision + 1",
      to: "SET snapshot_revision = snapshot_revision + 2",
      code: "missing-or-drifted-trigger",
      objectName: "session_entry_snapshots_after_insert",
    },
  ])("rejects $name drift through generated admission", ({ from, to, code, objectName }) => {
    const database = new DatabaseSync(":memory:");
    try {
      const driftedSql = OPENCLAW_AGENT_SCHEMA_SQL.replace(from, to);
      expect(driftedSql).not.toBe(OPENCLAW_AGENT_SCHEMA_SQL);
      database.exec(driftedSql);
      expect(collectSqliteSchemaIssues(database, OPENCLAW_AGENT_SCHEMA_SQL)).toContainEqual(
        expect.objectContaining({ code, objectName }),
      );
    } finally {
      database.close();
    }
  });
});
