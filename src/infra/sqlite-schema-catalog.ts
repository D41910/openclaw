import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteIndexContract,
  createSqliteTableContract,
  type SqliteIndexListRow,
  type SqliteIndexTermRow,
  type SqliteSchemaRow,
  type SqliteTableContract,
  type SqliteTableListRow,
} from "./sqlite-schema-contract-assembly.js";
import { normalizeSchemaSql, quoteSqliteIdentifier } from "./sqlite-schema-sql.js";

export type SqliteColumnCatalog = {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
  readonly hidden: number;
};

export type SqliteForeignKeyCatalog = {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly on_update: string;
  readonly on_delete: string;
  readonly match: string;
};

export type SqliteViewCatalog = {
  readonly name: string;
  readonly sql: string | null;
  readonly columns: readonly SqliteColumnCatalog[];
  readonly triggers: readonly Readonly<SqliteSchemaRow>[];
};

export type SqliteSchemaCatalog = {
  readonly tables: readonly {
    readonly name: string;
    readonly sql: string | null;
    readonly strict: number;
    readonly withoutRowid: number;
    readonly columns: readonly SqliteColumnCatalog[];
    readonly foreignKeys: readonly SqliteForeignKeyCatalog[];
    readonly indexes: readonly (Readonly<SqliteIndexListRow> & {
      readonly sql: string | null;
      readonly terms: readonly Readonly<SqliteIndexTermRow>[];
    })[];
    readonly triggers: readonly Readonly<SqliteSchemaRow>[];
  }[];
  readonly views: readonly SqliteViewCatalog[];
};

/** Generated strings have no runtime DDL path; dynamic migration owners supply native facts. */
export type SqliteSchemaSource = string | SqliteSchemaCatalog;

/** Preserve admission's historical column-order and automatic-index-name compatibility. */
export function sqliteSchemaContractFromCatalog(
  catalog: SqliteSchemaCatalog,
): ReadonlyMap<string, SqliteTableContract> {
  return new Map(
    catalog.tables.map((table) => [
      table.name,
      createSqliteTableContract(
        table.name,
        table,
        { schema: "main", name: table.name, strict: table.strict, wr: table.withoutRowid },
        table.indexes
          .map((index) => createSqliteIndexContract(index, index.sql, index.terms))
          .toSorted(compareJson),
        table.triggers,
        table.columns,
        table.foreignKeys,
      ),
    ]),
  );
}

type CatalogObject = SqliteSchemaRow & { type: string; tbl_name: string };
type IndexRow = SqliteIndexListRow & { table_name: string; index_seq: number; sql: string | null };
type IndexTermRow = SqliteIndexTermRow & { table_name: string; index_seq: number };
type ColumnRow = SqliteColumnCatalog & { table_name: string };
type ForeignKeyRow = SqliteForeignKeyCatalog & { table_name: string };

function groupRows<Row, Key extends string | number>(
  rows: readonly Row[],
  key: (row: Row) => Key,
): Map<Key, Row[]> {
  const groups = new Map<Key, Row[]>();
  for (const row of rows) {
    const name = key(row);
    const group = groups.get(name) ?? [];
    group.push(row);
    groups.set(name, group);
  }
  return groups;
}

/** Read one native catalog in six statements, independent of its table count. */
export function readSqliteSchemaCatalog(
  database: DatabaseSync,
  options: { viewNames?: readonly string[] } = {},
): SqliteSchemaCatalog {
  // Selecting the original columns preserves catalog authorizer behavior, including empty stores.
  const objects = database
    .prepare("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY name")
    .all() as CatalogObject[];
  const tables = objects.filter((row) => row.type === "table" && !row.name.startsWith("sqlite_"));
  const views = objects.filter(
    (row) => row.type === "view" && (!options.viewNames || options.viewNames.includes(row.name)),
  );
  if (tables.length === 0 && views.length === 0) {
    return { tables: [], views: [] };
  }
  const tableOptions = database.prepare("PRAGMA table_list").all() as SqliteTableListRow[];
  // A table/view in either schema can shadow a table-valued PRAGMA. Native PRAGMAs cannot be shadowed.
  const shadowed = tableOptions.some((row) =>
    [
      "pragma_index_list",
      "pragma_index_xinfo",
      "pragma_table_xinfo",
      "pragma_foreign_key_list",
    ].includes(row.name.toLowerCase()),
  );
  const indexes = shadowed
    ? undefined
    : groupRows(
        database
          .prepare(`
          SELECT t.name AS table_name, i.seq AS index_seq,
            i.name, i.origin, i.partial, i."unique", d.sql
          FROM main.sqlite_schema AS t
          CROSS JOIN pragma_index_list(t.name, 'main') AS i
          LEFT JOIN main.sqlite_schema AS d ON d.type = 'index' AND d.name = i.name
          WHERE t.type = 'table' AND substr(t.name, 1, 7) <> 'sqlite_'
        `)
          .all() as IndexRow[],
        (row) => row.table_name,
      );
  const terms = shadowed
    ? undefined
    : groupRows(
        database
          .prepare(`
          SELECT t.name AS table_name, i.seq AS index_seq,
            x.seqno, x.cid, x.name, x."desc", x.coll, x."key"
          FROM main.sqlite_schema AS t
          CROSS JOIN pragma_index_list(t.name, 'main') AS i
          CROSS JOIN pragma_index_xinfo(i.name, 'main') AS x
          WHERE t.type = 'table' AND substr(t.name, 1, 7) <> 'sqlite_'
          ORDER BY t.name, i.seq, x.seqno
        `)
          .all() as IndexTermRow[],
        (row) => row.table_name,
      );
  // Unrelated views may reference removed tables; only declared views need column inspection.
  const columnObjectClause = !options.viewNames
    ? "t.type IN ('table', 'view')"
    : options.viewNames.length > 0
      ? `t.type = 'table' OR (t.type = 'view' AND t.name IN (${options.viewNames.map(() => "?").join(", ")}))`
      : "t.type = 'table'";
  const columns = shadowed
    ? undefined
    : groupRows(
        database
          .prepare(`
          SELECT t.name AS table_name, x.cid, x.name, x.type, x."notnull", x.dflt_value, x.pk, x.hidden
          FROM main.sqlite_schema AS t
          CROSS JOIN pragma_table_xinfo(t.name, 'main') AS x
          WHERE (${columnObjectClause}) AND substr(t.name, 1, 7) <> 'sqlite_'
          ORDER BY t.name, x.cid
        `)
          .all(...(options.viewNames ?? [])) as ColumnRow[],
        (row) => row.table_name,
      );
  const foreignKeys = shadowed
    ? undefined
    : groupRows(
        database
          .prepare(`
          SELECT t.name AS table_name, f.id, f.seq, f."table", f."from", f."to",
            f.on_update, f.on_delete, f."match"
          FROM main.sqlite_schema AS t
          CROSS JOIN pragma_foreign_key_list(t.name, 'main') AS f
          WHERE t.type = 'table' AND substr(t.name, 1, 7) <> 'sqlite_'
          ORDER BY t.name, f.id, f.seq
        `)
          .all() as ForeignKeyRow[],
        (row) => row.table_name,
      );
  const triggers = groupRows(
    objects.filter((row) => row.type === "trigger"),
    (row) => row.tbl_name,
  );
  const indexSql = new Map(
    objects.filter((row) => row.type === "index").map((row) => [row.name, row.sql]),
  );
  const normalizedRow = (row: SqliteSchemaRow): SqliteSchemaRow => ({
    name: row.name,
    sql: normalizeSchemaSql(row.sql),
  });
  const readColumns = (name: string): SqliteColumnCatalog[] =>
    columns
      ? (columns.get(name) ?? []).map(({ table_name: _tableName, ...column }) => column)
      : (database
          .prepare(`PRAGMA main.table_xinfo(${quoteSqliteIdentifier(name)})`)
          .all() as SqliteColumnCatalog[]);
  const readTriggers = (name: string) => (triggers.get(name) ?? []).map(normalizedRow);
  return {
    tables: tables.map((table) => {
      const tableOption = tableOptions.find(
        (row) => row.schema === "main" && row.name === table.name,
      );
      if (!tableOption) {
        throw new Error(`Could not inspect SQLite table options for ${table.name}.`);
      }
      const nativeIndexes = indexes
        ? (indexes.get(table.name) ?? [])
        : (
            database
              .prepare(`PRAGMA main.index_list(${quoteSqliteIdentifier(table.name)})`)
              .all() as (SqliteIndexListRow & { seq: number })[]
          ).map(({ name, origin, partial, unique, seq }) => ({
            name,
            origin,
            partial,
            unique,
            index_seq: seq,
          }));
      const tableTerms = groupRows(terms?.get(table.name) ?? [], (row) => row.index_seq);
      return {
        name: table.name,
        sql: normalizeSchemaSql(table.sql),
        strict: tableOption.strict,
        withoutRowid: tableOption.wr,
        columns: readColumns(table.name),
        foreignKeys: foreignKeys
          ? (foreignKeys.get(table.name) ?? []).map(
              ({ table_name: _tableName, ...foreignKey }) => foreignKey,
            )
          : (database
              .prepare(`PRAGMA main.foreign_key_list(${quoteSqliteIdentifier(table.name)})`)
              .all() as SqliteForeignKeyCatalog[]),
        indexes: nativeIndexes
          .map((index) => ({
            name: index.name,
            origin: index.origin,
            partial: index.partial,
            unique: index.unique,
            sql: normalizeSchemaSql(indexSql.get(index.name) ?? null),
            terms: terms
              ? (tableTerms.get(index.index_seq) ?? []).map(
                  ({ table_name: _tableName, index_seq: _indexSeq, ...term }) => term,
                )
              : (database
                  .prepare(`PRAGMA main.index_xinfo(${quoteSqliteIdentifier(index.name)})`)
                  .all() as SqliteIndexTermRow[]),
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
        triggers: readTriggers(table.name),
      };
    }),
    views: views.map((view) => ({
      name: view.name,
      sql: normalizeSchemaSql(view.sql),
      columns: readColumns(view.name),
      triggers: readTriggers(view.name),
    })),
  };
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
