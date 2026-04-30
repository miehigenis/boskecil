/**
 * crsi-indicator.js — Cyclic RSI (cRSI) stateful module
 *
 * Ported from TradingView Pine Script:
 * "Decoding The Hidden Market Rhythm" — Chapter 4: Dynamic Cycles
 *
 * State: per-mint crsi buffer stored in memory (Map) + persisted to JSON file.
 * Buffer survives restarts via crsi-buffer.json.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUFFER_FILE = path.join(__dirname, "crsi-buffer.json");

// ── Config defaults ─────────────────────────────────────────────────────────
const DEFAULT_DOM_CYCLE = 20;
const DEFAULT_VIBRATION = 10;
const DEFAULT_LEVELING = 10.0; // percentile for bands (10 = bottom/top 10%)

// ── In-memory state ──────────────────────────────────────────────────────────
// Map<mint, { crsiHistory: number[], lastUpdate: number }>
const stateCache = new Map();

function loadBuffer() {
  try {
    if (fs.existsSync(BUFFER_FILE)) {
      const raw = JSON.parse(fs.readFileSync(BUFFER_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [mint, entry] of Object.entries(raw)) {
          if (entry && Array.isArray(entry.crsiHistory)) {
            stateCache.set(mint, entry);
          }
        }
      }
    }
  } catch (e) {
    // ignore corrupt buffer
  }
}

function saveBuffer() {
  const obj = Object.fromEntries(stateCache.entries());
  fs.writeFileSync(BUFFER_FILE, JSON.stringify(obj, null, 2));
}

// Load on first import
loadBuffer();

// ── Core cRSI computation ────────────────────────────────────────────────────

/**
 * Compute Wilder RSI from close prices.
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null}
 */
function computeWilderRSI(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // First average: simple mean of first period changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Subsequent: smoothed (Wilder smoothing)
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Compute cRSI (cyclic RSI) from close prices and previous crsi state.
 *
 * Pine Script formula:
 *   torque      = 2.0 / (vibration + 1)
 *   phasingLag  = (vibration - 1) / 2.0
 *   up          = rma(max(change(src), 0), cyclelen)
 *   down        = rma(-min(change(src), 0), cyclelen)
 *   rsi         = down == 0 ? 100 : up == 0 ? 0 : 100 - 100 / (1 + up/down)
 *   crsi        = torque * (2*rsi - rsi[phasingLag]) + (1-torque) * nz(crsi[1])
 *
 * @param {number[]} closes  - all close prices (oldest → newest)
 * @param {number[]} prevCrsiHistory - previous crsi values (index 0 = oldest)
 * @param {number} domCycle   - dominant cycle length (default 20)
 * @param {number} vibration  - vibration constant (default 10)
 * @returns {{ crsi: number, crsiHistory: number[] }}
 */
function computeCRSI(closes, prevCrsiHistory, domCycle = DEFAULT_DOM_CYCLE, vibration = DEFAULT_VIBRATION) {
  const cyclelen = Math.floor(domCycle / 2); // 10
  const torque = 2.0 / (vibration + 1);       // 2/11 ≈ 0.1818
  const phasingLag = Math.floor((vibration - 1) / 2); // floor(4.5) = 4

  // Build extended close array: prevCrsiHistory followed by current closes
  // prevCrsiHistory[0] = oldest, prevCrsiHistory[last] = most recent before current
  const extendedCloses = [...prevCrsiHistory.map(c => c), ...closes];

  // We need at least (prevCrsiHistory.length + 1 + cyclelen + phasingLag) closes
  // to compute current crsi. We compute crsi for each close in `closes`.
  const newHistory = [];

  for (let i = prevCrsiHistory.length; i < extendedCloses.length; i++) {
    const slice = extendedCloses.slice(Math.max(0, i - cyclelen), i + 1);
    const rsi = computeWilderRSI(slice, cyclelen);
    if (rsi === null) {
      newHistory.push(null);
      continue;
    }

    // rsi[phasingLag] — crsi value `phasingLag` bars ago
    const lagIndex = i - phasingLag;
    const rsiLag = lagIndex >= 0 ? extendedCloses[lagIndex] : rsi; // fallback to current if out of range

    // crsi[1] — previous crsi value
    const prevCrsi = newHistory.length > 0 ? newHistory[newHistory.length - 1] : null;

    let crsi;
    if (prevCrsi === null) {
      // First cRSI — no previous state, use raw RSI
      crsi = rsi;
    } else {
      crsi = torque * (2 * rsi - rsiLag) + (1 - torque) * prevCrsi;
    }

    newHistory.push(crsi);
  }

  // Return last crsi and full history
  const finalCrsi = newHistory.length > 0 ? newHistory[newHistory.length - 1] : null;
  return {
    crsi: finalCrsi,
    crsiHistory: newHistory.filter(v => v !== null),
  };
}

/**
 * Compute dynamic bands (db lower, ub upper) from crsi history.
 *
 * Pine Script sweeps 100 steps from min→max, finds level where
 * `leveling%` (10%) of crsi values fall below/above that level.
 *
 * @param {number[]} crsiHistory
 * @param {number} leveling - percentile (default 10)
 * @returns {{ db: number|null, ub: number|null }}
 */
function computeBands(crsiHistory, leveling = DEFAULT_LEVELING) {
  if (!Array.isArray(crsiHistory) || crsiHistory.length < 2) {
    return { db: null, ub: null };
  }

  // Filter valid numbers
  const valid = crsiHistory.filter(v => v !== null && Number.isFinite(v));
  if (valid.length < 2) return { db: null, ub: null };

  const lmin = Math.min(...valid);
  const lmax = Math.max(...valid);
  const mstep = (lmax - lmin) / 100;
  const aperc = leveling / 100;
  const cyclicmemory = valid.length;

  // Lower band (db) — sweep from lmin upward
  let db = lmin;
  outer: for (let steps = 0; steps <= 100; steps++) {
    const testvalue = lmin + mstep * steps;
    let below = 0;
    for (let m = 0; m < cyclicmemory; m++) {
      if (valid[m] < testvalue) below++;
    }
    const ratio = below / cyclicmemory;
    if (ratio >= aperc) {
      db = testvalue;
      break outer;
    }
  }

  // Upper band (ub) — sweep from lmax downward
  let ub = lmax;
  outer2: for (let steps = 0; steps <= 100; steps++) {
    const testvalue = lmax - mstep * steps;
    let above = 0;
    for (let m = 0; m < cyclicmemory; m++) {
      if (valid[m] >= testvalue) above++;
    }
    const ratio = above / cyclicmemory;
    if (ratio >= aperc) {
      ub = testvalue;
      break outer2;
    }
  }

  return { db, ub };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get cRSI indicators for a mint.
 *
 * @param {string} mint - token mint address
 * @param {number[]} closes - latest close prices (from candles)
 * @param {object} opts
 * @param {number} opts.domCycle - dominant cycle length (default 20)
 * @param {number} opts.vibration - vibration constant (default 10)
 * @param {number} opts.leveling - band percentile (default 10)
 * @returns {{ crsi: number|null, db: number|null, ub: number|null, state: object }}
 */
export function getCRSI(mint, closes, { domCycle = DEFAULT_DOM_CYCLE, vibration = DEFAULT_VIBRATION, leveling = DEFAULT_LEVELING } = {}) {
  if (!Array.isArray(closes) || closes.length === 0) {
    return { crsi: null, db: null, ub: null, state: null };
  }

  const state = stateCache.get(mint) || { crsiHistory: [], lastUpdate: 0 };
  const cyclicmemory = domCycle * 2;

  // Build extended history: previous crsi values + new closes
  // We need enough closes to compute 1 new crsi
  const minRequired = Math.max(1, Math.ceil(domCycle / 2) + Math.floor((vibration - 1) / 2) + 1);
  const extendedCloses = [...state.crsiHistory.slice(-(cyclicmemory * 2)).map(c => c), ...closes];

  const { crsi, crsiHistory: newCrsiValues } = computeCRSI(closes, state.crsiHistory, domCycle, vibration);

  // Combine old history with new values (keep last cyclicmemory)
  const fullHistory = [...state.crsiHistory, ...newCrsiValues].slice(-cyclicmemory);

  // Update state
  const newState = {
    crsiHistory: fullHistory,
    lastUpdate: Date.now(),
  };
  stateCache.set(mint, newState);

  // Compute bands from full history
  const { db, ub } = computeBands(fullHistory, leveling);

  // Fallback: if not enough history for cRSI bands, seed from RSI
  const MIN_HISTORY_FOR_CRSI_BANDS = 10;
  if (db === null || ub === null || fullHistory.length < MIN_HISTORY_FOR_CRSI_BANDS) {
    // Seed bands from RSI(2) so entry can still trigger while cRSI warms up
    const rsiSeed = computeWilderRSI(closes.slice(-50), Math.ceil(domCycle / 2));
    if (rsiSeed !== null) {
      const seedDb = rsiSeed * 0.7;  // approximate oversold
      const seedUb = rsiSeed * 1.3; // approximate overbought
      return {
        crsi,
        db: db ?? seedDb,
        ub: ub ?? seedUb,
        state: {
          historyLength: fullHistory.length,
          lastUpdate: newState.lastUpdate,
          seededFromRsi: true,
        },
      };
    }
  }

  return {
    crsi,
    db,
    ub,
    state: {
      historyLength: fullHistory.length,
      lastUpdate: newState.lastUpdate,
    },
  };
}

/**
 * Clear crsi buffer for a mint (e.g., after position closed).
 * @param {string} mint
 */
export function clearCRSIBuffer(mint) {
  stateCache.delete(mint);
}

/**
 * Persist buffer to disk.
 */
export function persistCRSIBuffer() {
  saveBuffer();
}

/**
 * Get all buffered mints (for debugging/admin).
 * @returns {object}
 */
export function getCRSIBufferStatus() {
  const entries = {};
  for (const [mint, entry] of stateCache.entries()) {
    entries[mint] = {
      historyLength: entry.crsiHistory.length,
      lastUpdate: entry.lastUpdate,
    };
  }
  return entries;
}

/**
 * Warm up buffer for a mint by prepending closes.
 * Called when resuming tracking for a mint with existing position.
 * @param {string} mint
 * @param {number[]} historicalCloses - older closes to prepend
 */
export function warmupCRSIBuffer(mint, historicalCloses) {
  if (!Array.isArray(historicalCloses) || historicalCloses.length === 0) return;
  const state = stateCache.get(mint) || { crsiHistory: [], lastUpdate: 0 };
  // Prepend historical closes (oldest first)
  state.crsiHistory = [...historicalCloses, ...state.crsiHistory].slice(-(DEFAULT_DOM_CYCLE * 2 * 2));
  stateCache.set(mint, state);
}
