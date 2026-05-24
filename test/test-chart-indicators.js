import assert from "node:assert/strict";

import {
  computeChartIndicatorsFromCandles,
  normalizeCandlesForIndicators,
} from "../tools/chart-indicators.js";

function makeRawCandle(ts, close) {
  return {
    ts: String(ts),
    h: String(close * 1.05),
    l: String(close * 0.95),
    c: String(close),
    vol: String(1000 + close),
  };
}

function makeAscendingFixture(count) {
  const start = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => makeRawCandle(start + i * 60_000, 1 + i * 0.1));
}

function testNormalizeSortsNewestFirstCandlesAscending() {
  const newestFirst = [
    makeRawCandle(1_700_000_003_000, 3),
    makeRawCandle(1_700_000_002_000, 2),
    makeRawCandle(1_700_000_001_000, 1),
  ];

  const normalized = normalizeCandlesForIndicators(newestFirst);

  assert.deepEqual(normalized.map((c) => c.ts), [1_700_000_001_000, 1_700_000_002_000, 1_700_000_003_000]);
  assert.equal(normalized.at(-1).close, 3);
  assert.equal(normalized.at(-1).volume, 1003);
}

function testSupertrendComputesWithElevenCandles() {
  const candles = normalizeCandlesForIndicators(makeAscendingFixture(11));
  const result = computeChartIndicatorsFromCandles("TEST_MINT", candles, {
    candles: 20,
    minCandles: 11,
    rsiLength: 2,
  });

  assert.equal(result.insufficient_data, false);
  assert.equal(result.candleCount, 11);
  assert.equal(result.usedCandles, 11);
  assert.equal(result.latest.candle.close, candles.at(-1).close);
  assert.equal(typeof result.latest.supertrend.direction, "string");
  assert.equal(Number.isFinite(result.latest.supertrend.value), true);
}

function testTenCandlesAreInsufficientForSupertrendGate() {
  const candles = normalizeCandlesForIndicators(makeAscendingFixture(10));
  const result = computeChartIndicatorsFromCandles("TEST_MINT_SHORT", candles, {
    candles: 20,
    minCandles: 11,
    rsiLength: 2,
  });

  assert.equal(result.insufficient_data, true);
  assert.equal(result.candleCount, 10);
  assert.equal(result.minCandles, 11);
}

testNormalizeSortsNewestFirstCandlesAscending();
testSupertrendComputesWithElevenCandles();
testTenCandlesAreInsufficientForSupertrendGate();

console.log("chart indicator regression tests passed");
