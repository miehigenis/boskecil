/**
 * backfillJsonl.js — ONE-TIME migration script
 *
 * Scans ALL positions in state.json marked `closed === true`, checks each
 * against ALL .jsonl log files for existing close_position entries, and
 * appends synthetic close_position entries for any that are missing.
 *
 * This is a ONE-TIME historical fix to ensure pnl-bot gets complete data.
 *
 * Run: node scripts/backfillJsonl.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "../state.json");
const LOG_DIR    = path.resolve(__dirname, "../logs");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[backfillJsonl] ${msg}`);
}

function todayLogFile() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `actions-${today}.jsonl`);
}

function appendJsonl(entry) {
  const line = JSON.stringify(entry);
  fs.appendFileSync(todayLogFile(), line + "\n");
  log(`  Appended: ${entry.tool} ${entry.result?.position ?? entry.args?.position_address ?? "?"}`);
}

// ─── Scan all JSONL files for existing close_position entries ─────────────────

function scanAllJsonlForCloses() {
  const closePositionIds = new Set();
  const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith("actions-") && f.endsWith(".jsonl"));

  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.tool === "close_position" && entry.result?.position) {
          closePositionIds.add(entry.result.position);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return closePositionIds;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("Starting one-time JSONL backfill for closed positions...");
  log(`State file: ${STATE_FILE}`);
  log(`Log dir   : ${LOG_DIR}`);

  // 1. Load state.json
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const allPositions = Object.entries(state.positions);
  log(`Total positions in state.json: ${allPositions.length}`);

  // 2. Filter to only closed === true
  const closedPositions = allPositions.filter(([, pos]) => pos.closed === true);
  log(`Positions with closed === true: ${closedPositions.length}`);

  // 3. Scan all JSONL files for existing close_position position IDs
  log("Scanning all JSONL files for existing close_position entries...");
  const alreadyLogged = scanAllJsonlForCloses();
  log(`Found ${alreadyLogged.size} unique position IDs with close_position entries in logs`);

  // 4. Find positions that need synthetic entries
  const toBackfill = closedPositions.filter(([posId]) => !alreadyLogged.has(posId));
  log(`Positions needing synthetic close_position entries: ${toBackfill.length}`);

  if (toBackfill.length === 0) {
    log("Nothing to do. All closed positions already have JSONL entries.");
    return;
  }

  // 5. Append synthetic entries for each missing one
  log(`Appending ${toBackfill.length} synthetic entries to ${path.basename(todayLogFile())}...`);

  for (const [posId, pos] of toBackfill) {
    const now = new Date().toISOString();

    const syntheticEntry = {
      timestamp: now,
      tool: "close_position",
      args: {
        position_address: posId,
        reason: "backfill-detected",
      },
      result: {
        success: true,
        backfill: true,
        position: posId,
        pool: pos.pool,
        pool_name: pos.pool_name,
        closed_at: pos.closed_at ?? now,
        note: "Synthetic entry from one-time backfill — position confirmed closed in state.json but missing from action logs",
      },
      duration_ms: 0,
      success: true,
    };

    appendJsonl(syntheticEntry);
  }

  // 6. Verify
  const todayFile = todayLogFile();
  const todayEntries = fs.readFileSync(todayFile, "utf8").trim().split("\n").filter(l => l.trim());
  const backfillCount = todayEntries.filter(l => {
    try {
      const e = JSON.parse(l);
      return e.result?.backfill === true;
    } catch { return false; }
  }).length;

  log(`Done. Today's log now has ${backfillCount} backfill entries (total lines: ${todayEntries.length})`);
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});