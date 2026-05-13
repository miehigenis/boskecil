/**
 * backfillClosedPositions.js
 *
 * Scans state.json positions where `closed !== true` and cross-checks each one
 * against the Meteora on-chain API. For positions confirmed closed on-chain but
 * missing from state.json:
 *   - Updates state.json (closed: true, closed_at, close_reason)
 *   - Appends a synthetic close_position JSONL log entry so pnl-bot counts are accurate
 *
 * Run in DRY-RUN mode first (--dry-run):
 *   node scripts/backfillClosedPositions.js --dry-run
 *
 * Then for real:
 *   node scripts/backfillClosedPositions.js
 *
 * Idempotent: safe to run multiple times.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// ─── Config ─────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "../state.json");
const LOG_DIR   = path.resolve(__dirname, "../logs");

const DRY_RUN = process.argv.includes("--dry-run");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[backfill] ${msg}`);
}

function loadState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function todayLogFile() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `actions-${today}.jsonl`);
}

function appendJsonl(entry) {
  if (DRY_RUN) return;
  const line = JSON.stringify(entry);
  fs.appendFileSync(todayLogFile(), line + "\n");
}

function getWalletPublicKey() {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../user-config.json"), "utf8"));
  const keypair = Keypair.fromSecretKey(bs58.decode(config.walletKey));
  return keypair.publicKey.toString();
}

// ─── Meteora API ─────────────────────────────────────────────────────────────

async function fetchOpenPositionsOnChain(walletPubkey) {
  const url = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletPubkey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  // Collect all position addresses from all pools
  const openPositions = [];
  for (const pool of data.pools || []) {
    for (const pos of pool.listPositions || []) {
      openPositions.push(pos);
    }
  }
  return openPositions;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting backfill${DRY_RUN ? " (DRY RUN)" : ""}...`);
  log(`State file: ${STATE_FILE}`);

  const state = loadState();
  const walletPubkey = getWalletPublicKey();
  log(`Wallet: ${walletPubkey}`);

  // 1. Get all open positions on-chain from Meteora
  log("Fetching open positions from Meteora API...");
  let onChainOpen;
  try {
    onChainOpen = await fetchOpenPositionsOnChain(walletPubkey);
  } catch (err) {
    log(`ERROR: Failed to fetch from Meteora: ${err.message}`);
    process.exit(1);
  }
  const onChainSet = new Set(onChainOpen);
  log(`Found ${onChainOpen.length} open position(s) on Meteora`);

  // 2. Find positions in state.json that appear closed but might still be open on-chain
  //    (i.e., state says closed=true but Meteora still shows it open — rare but possible)
  let needReopen = 0;
  for (const [posId, pos] of Object.entries(state.positions)) {
    if (pos.closed === true && onChainSet.has(posId)) {
      log(`WARNING: Position ${posId} marked closed in state but still open on Meteora — skipping (manual review needed)`);
    }
  }

  // 3. Find positions that look open in state.json (closed !== true) but are NOT on Meteora
  //    These need to be backfilled.
  const candidates = Object.entries(state.positions).filter(([, pos]) => pos.closed !== true);
  log(`Positions in state.json with closed !== true: ${candidates.length}`);

  const toClose = [];
  for (const [posId, pos] of candidates) {
    if (onChainSet.has(posId)) {
      // Still actually open on-chain — this is correct, skip
      log(`  ${posId}: still open on Meteora (correct, skipping)`);
    } else {
      // Not on Meteora — confirmed closed on-chain but state.json wasn't updated
      toClose.push({ posId, pos });
      log(`  ${posId}: NOT on Meteora — will mark as closed (pool: ${pos.pool_name || pos.pool})`);
    }
  }

  log(`\nPositions to backfill-close: ${toClose.length}`);

  if (toClose.length === 0) {
    log("Nothing to do. Exiting.");
    return;
  }

  // 4. Apply changes
  for (const { posId, pos } of toClose) {
    const now = new Date().toISOString();
    const reason = "backfill-detected";

    if (!DRY_RUN) {
      pos.closed = true;
      pos.closed_at = now;
      if (!pos.notes) pos.notes = [];
      pos.notes.push(`Auto-closed during backfill at ${now} (was in state but not on Meteora)`);
      if (!pos.close_reason) pos.close_reason = reason;
    }

    log(`Marked position ${posId} as closed (was in state but not on Meteora)`);

    // 5. Append synthetic close_position JSONL entry for pnl-bot
    const syntheticEntry = {
      timestamp: now,
      tool: "close_position",
      args: { position_address: posId, reason: "backfill-detected" },
      result: {
        success: true,
        backfill: true,
        position: posId,
        pool: pos.pool,
        pool_name: pos.pool_name,
        closed_at: now,
        note: "Synthetic entry from backfill script — position confirmed closed on Meteora but missing from state.json",
      },
      duration_ms: 0,
      success: true,
    };

    appendJsonl(syntheticEntry);
    log(`  Appended synthetic close_position JSONL entry for ${posId}`);
  }

  // 6. Save state.json
  if (!DRY_RUN) {
    saveState(state);
    log(`\nSaved updated state.json`);
  } else {
    log(`\nDRY RUN — state.json not modified`);
    log(`Would close ${toClose.length} position(s)`);
  }

  log(`\nDone.${DRY_RUN ? " Re-run without --dry-run to apply." : ""}`);
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});