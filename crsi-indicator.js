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
// Map<mint, { rsiHistory: number[], crsiHistory: number[], lastUpdate: number }>
const stateCache = new Map();

function loadBuffer() {
  try {
    if (fs.existsSync(BUFFER_FILE)) {
      const raw = JSON.parse(fs.readFileSync(BUFFER_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [mint, entry] of Object.entries(raw)) {
          if (entry && Array.isArray(entry.crsiHistory)) {
            stateCache.set(mint, { crsiHistory: entry.crsiHistory, lastUpdate: entry.lastUpdate || 0 });
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

// ── Core computations ──────────────────────────────────────────────────────

/**
 * Compute Wilder RSI from close prices.
 * Returns RSI series (one value per close).
 */
function computeWilderRSISeries(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return [];
  const rsiSeries = new Array(closes.length).fill(null);

  let avgGain = 0;
  let avgLoss = 0;

  // First average: simple mean
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < closes.length; i++) {
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    rsiSeries[i] = rsi;

    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  return rsiSeries;
}

/**
 * Compute cRSI (cyclic RSI) series from RSI series and previous cRSI state.
 *
 * Pine Script formula (applied per bar):
 *   crsi := torque * (2*rsi - rsi[phasingLag]) + (1-torque) * nz(crsi[1])
 *
 * This is applied bar-by-bar. crsi[1] means the previous bar's crsi value.
 * We simulate this sequentially: prev_crsi becomes the carry-over state.
 *
 * @param {number[]} rsiSeries - RSI values (one per close, nulls where insufficient data)
 * @param {number[]} prevCrsiHistory - previous cRSI values (oldest first)
 * @param {number} domCycle - dominant cycle (default 20)
 * @param {number} vibration - vibration constant (default 10)
 * @returns {{ crsiSeries: number[], newCrsiHistory: number[] }}
 */
function computeCRSISeries(rsiSeries, prevCrsiHistory, domCycle = DEFAULT_DOM_CYCLE, vibration = DEFAULT_VIBRATION) {
  const torque = 2.0 / (vibration + 1);      // 0.1818
  const phasingLag = Math.floor((vibration - 1) / 2); // 4

  // We need prevCrsiHistory[-1] (most recent previous cRSI) as carry-in
  const prevLast = prevCrsiHistory.length > 0 ? prevCrsiHistory[prevCrsiHistory.length - 1] : null;

  const crsiSeries = [];
  let carry = prevLast;

  for (let i = 0; i < rsiSeries.length; i++) {
    const rsi = rsiSeries[i];
    if (rsi === null || rsi === undefined) {
      crsiSeries.push(null);
      continue;
    }

    // rsi[phasingLag] in Pine Script means `phasingLag` bars back in the RSI series
    const lagIndex = i - phasingLag;
    const rsiLag = lagIndex >= 0 && rsiSeries[lagIndex] !== null
      ? rsiSeries[lagIndex]
      : rsi; // fallback to current if not available

    let crsi;
    if (carry === null) {
      // No previous cRSI — first valid value is just RSI
      crsi = rsi;
    } else {
      crsi = torque * (2 * rsi - rsiLag) + (1 - torque) * carry;
    }

    crsiSeries.push(crsi);
    carry = crsi;
  }

  // Filter valid and combine with prev history
  const newCrsiValues = crsiSeries.filter(v => v !== null);
  const fullHistory = [...prevCrsiHistory, ...newCrsiValues].slice(-(domCycle * 2));

  return { crsiSeries, newCrsiHistory: fullHistory };
}

/**
 * Compute dynamic bands (db lower, ub upper) from crsi history.
 *
 * Pine Script sweeps 100 steps from min→max, finds level where
 * `leveling%` (10%) of crsi values fall below/above that level.
 */
function computeBands(crsiHistory, leveling = DEFAULT_LEVELING) {
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
    if (below / cyclicmemory >= aperc) { db = testvalue; break outer; }
  }

  // Upper band (ub) — sweep from lmax downward
  let ub = lmax;
  outer2: for (let steps = 0; steps <= 100; steps++) {
    const testvalue = lmax - mstep * steps;
    let above = 0;
    for (let m = 0; m < cyclicmemory; m++) {
      if (valid[m] >= testvalue) above++;
    }
    if (above / cyclicmemory >= aperc) { ub = testvalue; break outer2; }
  }

  return { db, ub };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get cRSI indicators for a mint.
 *
 * @param {string} mint - token mint address
 * @param {number[]} closes - latest close prices (from candles, oldest → newest)
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

  const state = stateCache.get(mint) || { rsiHistory: [], crsiHistory: [], lastUpdate: 0 };
  const cyclelen = Math.floor(domCycle / 2); // 10

  // How many historical closes we need for continuity:
  // RSI needs (cyclelen + 1) closes to warm up
  // cRSI needs prevCrsiHistory for the carry-over
  // We extend closes by prepending from state.rsiHistory (which tracks RSI, not prices)
  // to get smooth RSI continuity.
  //
  // state.rsiHistory = RSI values from previous calls (oldest → newest)
  // Warm-up: we need cyclelen+period closes to get first valid RSI.
  // To support cRSI carry-over across calls, we keep previous cRSI state.
  // RSI is recomputed fresh each call (state carries in crsiHistory, not rsiHistory).

  const lookback = cyclelen + Math.floor((vibration - 1) / 2); // 10 + 4 = 14

  // Fresh RSI series from current closes
  const freshRsiSeries = computeWilderRSISeries(closes, cyclelen);

  // Carry-over: previous cRSI values from state
  const prevCrsiHistory = state.crsiHistory.slice(-(domCycle * 2));

  // Compute cRSI series with carry-over from previous state
  const { crsiSeries, newCrsiHistory } = computeCRSISeries(
    freshRsiSeries,
    prevCrsiHistory,
    domCycle,
    vibration
  );

  // Update state: carry forward cRSI history
  const newState = {
    crsiHistory: newCrsiHistory,
    lastUpdate: Date.now(),
  };
  stateCache.set(mint, newState);

  // Current cRSI = last valid value
  const crsi = crsiSeries.length > 0 ? crsiSeries[crsiSeries.length - 1] : null;

  // Compute bands
  const { db, ub } = computeBands(newCrsiHistory, leveling);

  // Fallback: if bands unreliable (insufficient history), seed from RSI extremes
  const MIN_HISTORY_FOR_CRSI_BANDS = 10;
  const crsiHistory = newCrsiHistory;
  if (crsiHistory.length < MIN_HISTORY_FOR_CRSI_BANDS && crsi !== null) {
    return {
      crsi,
      db: 25,   // fixed oversold approximation
      ub: 75,   // fixed overbought approximation
      state: {
        historyLength: crsiHistory.length,
        lastUpdate: newState.lastUpdate,
        seededFromRsi: true,
      },
    };
  }

  return {
    crsi,
    db,
    ub,
    state: {
      historyLength: newCrsiHistory.length,
      lastUpdate: newState.lastUpdate,
    },
  };
}

/**
 * Clear crsi buffer for a mint (e.g., after position closed).
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
 */
export function getCRSIBufferStatus() {
  const entries = {};
  for (const [mint, entry] of stateCache.entries()) {
    entries[mint] = {
      crsiHistoryLength: entry.crsiHistory?.length || 0,
      lastUpdate: entry.lastUpdate,
    };
  }
  return entries;
}

/**
 * Warm up buffer for a mint with historical closes (call before resuming).
 * @param {string} mint
 * @param {number[]} historicalCloses - older closes (oldest → newest)
 */
export function warmupCRSIBuffer(mint, historicalCloses) {
  if (!Array.isArray(historicalCloses) || historicalCloses.length === 0) return;
  const domCycle = DEFAULT_DOM_CYCLE;
  const cyclelen = Math.floor(domCycle / 2);
  const rsiSeries = computeWilderRSISeries(historicalCloses, cyclelen);
  const state = stateCache.get(mint) || { crsiHistory: [], lastUpdate: 0 };
  const { crsiSeries } = computeCRSISeries(rsiSeries, state.crsiHistory, domCycle, DEFAULT_VIBRATION);
  state.crsiHistory = crsiSeries.filter(v => v !== null).slice(-(domCycle * 2));
  state.lastUpdate = Date.now();
  stateCache.set(mint, state);
}
