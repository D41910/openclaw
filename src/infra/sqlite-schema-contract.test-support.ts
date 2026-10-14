import type { SqliteSchemaCatalog, SqliteSchemaSource } from "./sqlite-schema-catalog.js";
import {
  assertSqliteSchemaContains as assertContains,
  assertSqliteSchemaTablesPresent as assertTablesPresent,
  collectSqliteSchemaIssues as collectIssues,
} from "./sqlite-schema-contract.js";
import { buildDynamicSqliteSchemaCatalog } from "./sqlite-schema-dynamic.js";

const fixtures = new Map<string, SqliteSchemaCatalog>();

/** Synthetic and frozen previous-release DDL is not part of the generated runtime inventory. */
export function sqliteSchemaFixture(source: SqliteSchemaSource): SqliteSchemaCatalog {
  if (typeof source !== "string") {
    return source;
  }
  let catalog = fixtures.get(source);
  if (!catalog) {
    catalog = buildDynamicSqliteSchemaCatalog(source);
    fixtures.set(source, catalog);
  }
  return catalog;
}

export function assertSqliteSchemaContains(...args: Parameters<typeof assertContains>): void {
  const [database, label, schema, ...options] = args;
  assertContains(database, label, sqliteSchemaFixture(schema), ...options);
}

export function assertSqliteSchemaTablesPresent(
  ...args: Parameters<typeof assertTablesPresent>
): void {
  const [database, label, schema, ...options] = args;
  assertTablesPresent(database, label, sqliteSchemaFixture(schema), ...options);
}

export function collectSqliteSchemaIssues(...args: Parameters<typeof collectIssues>) {
  const [database, schema, ...options] = args;
  return collectIssues(database, sqliteSchemaFixture(schema), ...options);
}
