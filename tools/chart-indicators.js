/**
 * chart-indicators.js — Local indicator computation
 *
 * All indicators computed locally from candles fetched via onchainos CLI.
 * NO external API calls to agentmeridian.xyz.
 *
 * Indicators: RSI, Bollinger Bands, Supertrend, VWAP
 * Entry presets: rsi_extreme, rsi_reversal, bb_plus_rsi, crsi_extreme, etc.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { spawnSync } from "child_process";
import { getCRSI, persistCRSIBuffer } from "../crsi-indicator.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;
const CLI = "/home/ubuntu/.local/bin/onchainos";

// bar to interval mapping for onchainos
const BAR_MAP = {
  "1_MINUTE":  "1m",
  "5_MINUTE":  "5m",
  "15_MINUTE": "15m",
};

export function fetchCandles(mint, bar = "5m", limit = 299) {
  try {
    const raw = spawnSync(CLI, [
      "market", "kline",
      "--chain", "solana",
      "--address", mint,
      "--bar", bar,
      "--limit", String(limit),
    ], { encoding: "utf8", timeout: 15000 });
    if (!raw.stdout) return [];
    let data;
    try { data = JSON.parse(raw.stdout); } catch { return []; }
    const candles = Array.isArray(data.data) ? data.data
               : Array.isArray(data) ? data : [];
    return candles.map((c) => ({
      high:   parseFloat(c.high   || c.h || 0),
      low:    parseFloat(c.low    || c.l || 0),
      close:  parseFloat(c.close  || c.c || 0),
      volume: parseFloat(c.volume || c.v || 0),
    })).filter((c) => c.close > 0);
  } catch { return []; }
}

// ── Local Indicator Computations ─────────────────────────────────────────────

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Wilder RSI — same as Pine Script's rma() based RSI */
function computeRSI(closes, period = 2) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Bollinger Bands — SMA middle, stddev outer */
function computeBollingerBands(closes, period = 20, mult = 2.0) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - sma, 2), 0) / period;
  const stddev = Math.sqrt(variance);
  return {
    upper: sma + mult * stddev,
    middle: sma,
    lower: sma - mult * stddev,
  };
}

/** Supertrend — atr-based trend following indicator */
function computeSupertrend(highs, lows, closes, period = 10, multiplier = 3.0) {
  if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) return null;
  if (highs.length < period || highs.length !== lows.length || highs.length !== closes.length) return null;

  const atr = computeATR(highs, lows, closes, period);
  if (atr === null) return null;

  const hl2 = closes.map((c, i) => (highs[i] + lows[i]) / 2);
  const upperBand = hl2.map((v, i) => v + multiplier * atr);
  const lowerBand = hl2.map((v, i) => v - multiplier * atr);

  let direction = 1; // 1 = bullish, -1 = bearish
  let supertrendValue = lowerBand[lowerBand.length - 1];
  let breakUp = false;
  let breakDown = false;

  for (let i = 1; i < closes.length; i++) {
    const prevST = supertrendValue;
    const prevDir = direction;

    if (closes[i] > upperBand[i - 1]) {
      direction = 1;
      supertrendValue = lowerBand[i];
    } else if (closes[i] < lowerBand[i - 1]) {
      direction = -1;
      supertrendValue = upperBand[i];
    } else {
      supertrendValue = direction === 1 ? lowerBand[i] : upperBand[i];
    }

    if (direction === 1 && prevDir === -1) breakUp = true;
    if (direction === -1 && prevDir === 1) breakDown = true;
  }

  return {
    value: supertrendValue,
    direction: direction === 1 ? "bullish" : "bearish",
    breakUp,
    breakDown,
  };
}

/** Average True Range */
function computeATR(highs, lows, closes, period = 14) {
  if (!Array.isArray(highs) || highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ── VWAP Calculations ───────────────────────────────────────────────────────

function calcVWAP(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let cumulativeTPV = 0;
  let cumulativeVol = 0;
  for (const c of candles) {
    const typicalPrice = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    const volume = Number(c.volume) || 0;
    cumulativeTPV += typicalPrice * volume;
    cumulativeVol += volume;
  }
  return cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : null;
}

function findVwapATH(candles, lookback = 100) {
  if (!Array.isArray(candles) || candles.length < 10) return null;
  const recent = candles.slice(-lookback);
  let maxVwap = -Infinity;
  let cumulativeTPV = 0;
  let cumulativeVol = 0;
  for (const c of recent) {
    const typicalPrice = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    const volume = Number(c.volume) || 0;
    cumulativeTPV += typicalPrice * volume;
    cumulativeVol += volume;
    const vwap = cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : null;
    if (vwap != null && vwap > maxVwap) maxVwap = vwap;
  }
  return maxVwap > 0 ? maxVwap : null;
}

export function calculateVWAPSlope(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length < period * 2) {
    return { slope: 0, rising: null, vwap_current: null, vwap_prior: null, insufficient_data: true, vwapAth: null, distanceFromAthPct: null };
  }
  const recent = candles.slice(-period);
  const prior  = candles.slice(-period * 2, -period);
  const vwapCurrent = calcVWAP(recent);
  const vwapPrior   = calcVWAP(prior);
  if (vwapCurrent == null || vwapPrior == null || vwapPrior === 0) {
    return { slope: 0, rising: null, vwap_current: vwapCurrent, vwap_prior: vwapPrior, insufficient_data: true, vwapAth: null, distanceFromAthPct: null };
  }
  const slope  = (vwapCurrent - vwapPrior) / vwapPrior;
  const rising = slope > 0.005;
  const vwapAth = findVwapATH(candles, 100);
  let distanceFromAthPct = null;
  if (vwapAth != null && vwapAth > 0 && vwapCurrent > 0) {
    distanceFromAthPct = Math.round(((vwapCurrent - vwapAth) / vwapAth) * 10000) / 100;
  }
  return {
    slope:            Math.round(slope * 10000) / 10000,
    rising,
    vwap_current:     vwapCurrent,
    vwap_prior:       vwapPrior,
    insufficient_data: false,
    vwapAth,
    distanceFromAthPct,
  };
}

export function getVwapIndicators(mint) {
  const candles = fetchCandles(mint, "5m", 299);
  if (candles.length < 40) {
    return { rising: null, slopePct: null, vwapAth: null, distanceFromAthPct: null, insufficient_data: true };
  }
  const result = calculateVWAPSlope(candles, 20);
  return {
    rising:             result.rising,
    slopePct:           result.slope != null ? (result.slope * 100).toFixed(2) : null,
    vwapAth:            result.vwapAth ?? null,
    distanceFromAthPct: result.distanceFromAthPct,
    insufficient_data:   result.insufficient_data,
  };
}

// ── Local chart indicators for a mint ───────────────────────────────────────

/**
 * Compute all chart indicators locally for a mint.
 * Replaces the external API call to agentmeridian.xyz.
 *
 * @param {string} mint
 * @param {object} opts
 * @param {string} opts.interval - "5_MINUTE" or "15_MINUTE"
 * @param {number} opts.candles - number of candles to fetch
 * @param {number} opts.rsiLength - RSI period
 * @param {boolean} opts.refresh - force refresh (always false for local, existing data kept in cRSI buffer)
 */
export function computeChartIndicatorsLocal(mint, {
  interval = "5_MINUTE",
  candles = 298,
  rsiLength = 2,
  domCycle = 20,
  vibration = 10,
  leveling = 10,
} = {}) {
  const bar = BAR_MAP[interval] || "5m";
  const allCandles = fetchCandles(mint, bar, candles + 40); // extra for lookback
  if (allCandles.length < candles) {
    return { insufficient_data: true, latest: null };
  }

  const recent = allCandles.slice(-candles);
  const previous = allCandles.slice(-candles - 1, -1);
  const closes = recent.map(c => c.close);
  const highs  = recent.map(c => c.high);
  const lows   = recent.map(c => c.low);
  const prevCloses = previous.map(c => c.close);

  const latestClose = closes[closes.length - 1];
  const prevClose = prevCloses[prevCloses.length - 1];

  // RSI
  const rsi = computeRSI(closes, rsiLength);

  // Bollinger
  const bb = computeBollingerBands(closes, 20, 2.0);

  // Supertrend
  const st = computeSupertrend(highs, lows, closes, 10, 3.0);

  // cRSI
  const crsiResult = getCRSI(mint, closes, { domCycle, vibration, leveling });
  const { crsi, db, ub } = crsiResult;

  return {
    insufficient_data: false,
    latest: {
      candle: { close: latestClose },
      previousCandle: { close: prevClose },
      rsi: { value: rsi },
      bollinger: bb ? { upper: bb.upper, middle: bb.middle, lower: bb.lower } : {},
      supertrend: st || {},
      states: st ? {
        supertrendBreakUp: st.breakUp,
        supertrendBreakDown: st.breakDown,
      } : {},
      crsi: { value: crsi, db, ub },
    },
  };
}

// ── Preset Evaluation ────────────────────────────────────────────────────────

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => value === "1_MINUTE" || value === "5_MINUTE" || value === "15_MINUTE");
}

function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNum(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const crsiData = latest?.crsi || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    close: safeNum(candle.close),
    previousClose: safeNum(previousCandle.close),
    rsi,
    crsi: safeNum(crsiData.value),
    crsiDb: safeNum(crsiData.db),
    crsiUb: safeNum(crsiData.ub),
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

function evaluatePreset(side, preset, payload, opts = {}) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(opts.rsiOversold ?? 30);
  const overbought = Number(opts.rsiOverbought ?? 70);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const crsi = summary.crsi;
  const crsiDb = summary.crsiDb;
  const crsiUb = summary.crsiUb;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const crossedUp = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "rsi_extreme":
      return side === "entry"
        ? {
            confirmed: rsi != null && (rsi <= oversold || rsi >= overbought),
            reason: rsi <= oversold
              ? `RSI ${rsi ?? "n/a"} oversold (<= ${oversold})`
              : `RSI ${rsi ?? "n/a"} overbought (>= ${overbought})`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "crsi_extreme":
      return side === "entry"
        ? {
            confirmed: crsi != null && crsiDb != null && crsiUb != null && (crsi <= crsiDb || crsi >= crsiUb),
            reason: crsi <= crsiDb
              ? `cRSI ${crsi?.toFixed(2)} <= lower band ${crsiDb?.toFixed(2)} (oversold)`
              : crsi >= crsiUb
              ? `cRSI ${crsi?.toFixed(2)} >= upper band ${crsiUb?.toFixed(2)} (overbought)`
              : `cRSI ${crsi?.toFixed(2)} in band range`,
            signal: summary,
          }
        : {
            confirmed: crsi != null && crsiUb != null && crsi >= crsiUb,
            reason: crsi != null && crsiUb != null
              ? `cRSI ${crsi.toFixed(2)} >= upper band ${crsiUb.toFixed(2)}`
              : `cRSI ${crsi ?? "n/a"} no exit signal`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: `RSI oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: `RSI overbought with bearish Supertrend context`,
            signal: summary,
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi <= oversold),
            reason: "Supertrend bullish confirmation or RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: "Supertrend bearish confirmation or RSI overbought",
            signal: summary,
          };
    case "rsi_supertrend_cross":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi >= overbought && (summary.supertrendBreakUp || isBullish)) ||
              (rsi != null && rsi <= oversold  && (summary.supertrendBreakDown || isBearish)),
            reason: rsi >= overbought
              ? `RSI overbought (${rsi?.toFixed(2)}) + bullish Supertrend — entry`
              : `RSI oversold (${rsi?.toFixed(2)}) + bearish Supertrend — entry`,
            signal: summary,
          }
        : {
            confirmed: false,
            reason: "No exit logic for this preset — manual exit only",
            signal: summary,
          };
    case "rsi_overbought_supertrend":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi >= overbought && (summary.supertrendBreakUp || isBullish),
            reason: rsi != null
              ? `RSI ${rsi.toFixed(2)} >= overbought ${overbought} with bullish Supertrend`
              : "RSI unavailable",
            signal: summary,
          }
        : {
            confirmed: false,
            reason: "No exit logic for this preset — use exitPreset separately",
            signal: summary,
          };
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold,
            reason: "Close at/below lower band with RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought,
            reason: "Close at/above upper band with RSI overbought",
            signal: summary,
          };
    case "fibo_reclaim":
      return side === "entry"
        ? {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50) ||
              crossedUp(summary.fib786),
            reason: "Price reclaimed a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50),
            reason: "Price reclaimed a key Fibonacci level upward",
            signal: summary,
          };
    case "fibo_reject":
      return side === "entry"
        ? {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50),
            reason: "Price rejected from a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50) ||
              crossedDown(summary.fib786),
            reason: "Price rejected below a key Fibonacci level",
            signal: summary,
          };
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

// ── Public API (same interface as before, but now local) ────────────────────

/**
 * Alias for backwards compatibility — now uses local computation.
 * @deprecated Use computeChartIndicatorsLocal directly
 */
export async function fetchChartIndicatorsForMint(mint, opts = {}) {
  const interval = opts.interval || "5_MINUTE";
  const candles = opts.candles || 298;
  const rsiLength = opts.rsiLength || 2;
  const domCycle = opts.domCycle || config.indicators?.domCycle || 20;
  const vibration = opts.vibration || config.indicators?.vibration || 10;
  const leveling = opts.leveling || config.indicators?.leveling || 10;

  return computeChartIndicatorsLocal(mint, { interval, candles, rsiLength, domCycle, vibration, leveling });
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
} = {}) {
  if (!config.indicators.enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
  }

  const rsiOversold = config.indicators.rsiOversold ?? 29;
  const rsiOverbought = config.indicators.rsiOverbought ?? 70;
  const domCycle = config.indicators.domCycle ?? 20;
  const vibration = config.indicators.vibration ?? 10;
  const leveling = config.indicators.leveling ?? 10;
  const candles = config.indicators.candles ?? 298;
  const rsiLength = config.indicators.rsiLength ?? 2;

  const opts = { rsiOversold, rsiOverbought, domCycle, vibration, leveling };

  const results = [];
  for (const interval of targets) {
    try {
      const payload = computeChartIndicatorsLocal(mint, {
        interval,
        candles,
        rsiLength,
        domCycle,
        vibration,
        leveling,
      });
      // Insufficient data = skip this interval (treat as "not confirmed but don't fail")
      if (payload?.insufficient_data) {
        results.push({
          interval,
          ok: true,
          confirmed: null, // null = skipped (neither confirmed nor rejected)
          reason: "Insufficient candle data for indicator computation",
          signal: null,
          latest: null,
        });
        continue;
      }
      const evaluation = evaluatePreset(side, preset, payload, opts);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator compute failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator computation failed; proceeding optimistically",
      intervals: results,
    };
  }

  // Entries with confirmed=null = insufficient candle data (young token) — skip, don't reject
  const decidable = successful.filter((entry) => entry.confirmed !== null);
  if (decidable.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Insufficient candle data on all intervals — skipping indicator filter",
      intervals: results,
    };
  }

  const requireAll = !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? decidable.every((entry) => entry.confirmed)
    : decidable.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${decidable.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `${preset} not confirmed on ${decidable.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}
