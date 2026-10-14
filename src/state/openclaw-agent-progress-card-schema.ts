import type { DatabaseSync } from "node:sqlite";
import {
  AGENT_PROGRESS_CARD_SCHEMA_SQL,
  SESSION_PROGRESS_CARDS_TABLE,
} from "./openclaw-agent-schema-history.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export {
  AGENT_PROGRESS_CARD_SCHEMA_SQL,
  AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL,
  SESSION_PROGRESS_CARDS_TABLE,
} from "./openclaw-agent-schema-history.js";

/** Ensure the additive progress-card table inside the caller's write transaction. */
export function ensureOpenClawAgentProgressCardSchemaInTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) {
    throw new Error("progress-card schema ensure requires an active transaction");
  }
  if (tableExists(db, SESSION_PROGRESS_CARDS_TABLE)) {
    return;
  }
  db.exec(AGENT_PROGRESS_CARD_SCHEMA_SQL); // sqlite-allow-raw -- Canonical DDL bootstrap for the lazy progress-card schema.
}
