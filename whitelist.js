/**
 * Token Whitelist — priority list for the screener.
 *
 * - Tokens in the whitelist are PRIORITY: screener always attempts to deploy into them.
 * - GMGN S1 rank filter is BYPASSED for whitelist tokens.
 * - GMGN S2 token info filter is BYPASSED for whitelist tokens (only S3+ filters apply).
 * - Pool-memory cooldowns are BYPASSED for whitelist tokens (blacklist is NOT bypassed).
 * - Entry indicators (checkBounceSetup / Stage4) STILL APPLY — can't override those.
 * - Deterministic exit rules STILL APPLY — can't override those.
 * - User-config parameters (S3+) can still reject whitelist tokens.
 *
 * Whitelist flow for whitelisted tokens:
 *   S1: bypass (rank filter) → S2: bypass (info filter) → S3: pool only (no holders/traders fetch)
 *   → S4: indicators (fail-closed) → S5: pool selection + volatility → DEPLOY
 *
 * Tokens auto-expire after whitelistTtlHours (default 6h).
 * Persisted to whitelist.json.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WHITELIST_PATH = path.join(__dirname, "whitelist.json");

const DEFAULT_TTL_HOURS = 6;

let _cache = null; // in-memory cache, refreshed on demand

// ── persistence ────────────────────────────────────────────────────────────

function readWhitelist() {
  try {
    if (fs.existsSync(WHITELIST_PATH)) {
      const raw = fs.readFileSync(WHITELIST_PATH, "utf8");
      return JSON.parse(raw);
    }
  } catch (_) {}
  return { tokens: {} };
}

function writeWhitelist(data) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(data, null, 2), "utf8");
}

// ── core logic ─────────────────────────────────────────────────────────────

/**
 * Add a token to the whitelist.
 * @param {string} mint - token mint address
 * @param {number} [ttlHours] - TTL in hours (default from config or 6)
 * @param {string} [addedBy] - who added it (e.g. "telegram:7231213682")
 * @param {string} [note] - optional note
 */
export function addToWhitelist(mint, ttlHours = null, addedBy = "unknown", note = null) {
  const ttl = ttlHours ?? config.screening?.whitelistTtlHours ?? DEFAULT_TTL_HOURS;
  const data = readWhitelist();
  const now = Date.now();
  data.tokens[mint] = {
    addedAt: now,
    expiresAt: now + ttl * 3600 * 1000,
    addedBy,
    note,
  };
  writeWhitelist(data);
  _cache = null; // invalidate
}

/**
 * Remove a token from the whitelist.
 */
export function removeFromWhitelist(mint) {
  const data = readWhitelist();
  if (data.tokens[mint]) {
    delete data.tokens[mint];
    writeWhitelist(data);
    _cache = null;
    return true;
  }
  return false;
}

/**
 * Returns true if the token is currently whitelisted and not expired.
 * Auto-cleans expired entries on read.
 */
export function isWhitelisted(mint) {
  const data = readWhitelist();
  const now = Date.now();
  let hasChanges = false;

  for (const [key, entry] of Object.entries(data.tokens)) {
    if (entry.expiresAt < now) {
      delete data.tokens[key];
      hasChanges = true;
    }
  }

  if (hasChanges) writeWhitelist(data);

  return Boolean(data.tokens[mint]?.expiresAt > now);
}

/**
 * Get all active (non-expired) whitelisted mints.
 */
export function getWhitelistedMints() {
  const data = readWhitelist();
  const now = Date.now();

  for (const [key, entry] of Object.entries(data.tokens)) {
    if (entry.expiresAt < now) {
      delete data.tokens[key];
    }
  }
  writeWhitelist(data);

  return Object.keys(data.tokens);
}

/**
 * Get full whitelist entries (for display).
 */
export function getWhitelistEntries() {
  const data = readWhitelist();
  const now = Date.now();
  const entries = [];

  for (const [mint, entry] of Object.entries(data.tokens)) {
    if (entry.expiresAt >= now) {
      const remaining = Math.max(0, entry.expiresAt - now);
      const remainingHours = (remaining / 3600 / 1000).toFixed(1);
      entries.push({ mint, ...entry, remainingHours });
    }
  }

  // sort by expiresAt (soonest first)
  entries.sort((a, b) => a.expiresAt - b.expiresAt);
  return entries;
}

/**
 * Format whitelist as Telegram-friendly text.
 */
export function formatWhitelist() {
  const entries = getWhitelistEntries();
  if (entries.length === 0) return "Whitelist empty.";

  const lines = ["<b>Whitelist</b> (" + entries.length + " active):"];
  for (const e of entries) {
    const note = e.note ? ` — ${e.note}` : "";
    lines.push(
      `• <code>${e.mint.slice(0, 8)}...</code> | ${e.remainingHours}h left${note}`
    );
  }
  return lines.join("\n");
}
