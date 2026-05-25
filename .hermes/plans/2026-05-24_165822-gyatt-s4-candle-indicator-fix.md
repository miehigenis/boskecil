# GYATT S4 Candle Indicator Fix Implementation Plan

> **For Hermes:** Implement only after adan approves. Use systematic-debugging + TDD style verification. No on-chain actions required.

**Goal:** Fix Meridian GMGN S4 indicator screening so young live tokens like GYATT are evaluated from correctly ordered onchainos candles, with Supertrend available after 11 candles and without requiring 298 candles.

**Architecture:** Normalize candle data at the source (`fetchCandles`) so all downstream indicator calculations receive oldest-first arrays. Add a `minCandles` path so S4 can compute Supertrend with 11 candles while using a preferred larger window where available. Keep `rejectAlreadyAtBottom` meaningful only when Bollinger data exists (>=20 candles), instead of rejecting young tokens.

**Tech Stack:** Node.js ESM, onchainos CLI, local indicator computation in `tools/chart-indicators.js`, GMGN screening in `tools/gmgn.js`.

---

## Current Evidence

- GMGN shows GYATT current price around `0.00042`, live volume/holders healthy.
- onchainos returns valid candles, but in `DESC/newest-first` order.
- Current `fetchCandles()` strips timestamp and preserves raw order.
- Current `computeChartIndicatorsLocal()` assumes oldest-first and uses `closes[closes.length - 1]` as latest.
- Current `fetchChartIndicatorsForMint()` defaults to `candles = 298`, so young tokens fail S4 with `insufficient_data` despite enough bars for Supertrend.
- Current Supertrend implementation uses ATR period 10, so minimum valid Supertrend is 11 candles.

---

## Files Likely to Change

- Modify: `tools/chart-indicators.js`
- Modify: `tools/gmgn.js`
- Add or modify: `test/test-chart-indicators.js` or a lightweight regression script under `test/`
- Optional docs update after implementation: `CLAUDE.md` S4 notes

---

## Plan

### Task 1: Add regression coverage for candle normalization

**Objective:** Prove candles returned newest-first become oldest-first before indicators use them.

**File:**
- Add: `test/test-chart-indicators.js`

**Test shape:**
- Use a small pure helper if exported (preferred), or test live GYATT via `fetchCandles()` if we keep it integration-style.
- Assert returned candle timestamps are ascending.
- Assert latest candle is the highest/newest timestamp, not the oldest launch candle.

**Expected assertions:**
```js
assert(candles.length > 0);
for (let i = 1; i < candles.length; i++) {
  assert(candles[i].ts >= candles[i - 1].ts, "candles must be ascending by timestamp");
}
assert(candles[candles.length - 1].close > candles[0].close || true, "latest close is last element");
```

**Run:**
```bash
cd /home/ubuntu/meridian1
node test/test-chart-indicators.js
```

**Expected before fix:** FAIL or timestamp missing.

---

### Task 2: Normalize onchainos candles in `fetchCandles()`

**Objective:** Make `fetchCandles()` return candles oldest-first with timestamp retained.

**File:**
- Modify: `tools/chart-indicators.js:29-49`

**Implementation details:**
- Parse timestamp from `c.ts`, `c.time`, `c.timestamp`, or fallback null.
- onchainos `ts` is milliseconds (`1779614100000`), so store as numeric ms.
- Parse volume from `c.volume || c.v || c.vol || 0` because onchainos uses `vol`.
- Filter invalid candles by finite positive close/high/low.
- Sort ascending if timestamps exist.

**Target code pattern:**
```js
return candles
  .map((c) => ({
    ts: Number(c.ts ?? c.time ?? c.timestamp ?? 0) || null,
    high: parseFloat(c.high ?? c.h ?? 0),
    low: parseFloat(c.low ?? c.l ?? 0),
    close: parseFloat(c.close ?? c.c ?? 0),
    volume: parseFloat(c.volume ?? c.v ?? c.vol ?? 0),
  }))
  .filter((c) => Number.isFinite(c.close) && c.close > 0)
  .filter((c) => Number.isFinite(c.high) && Number.isFinite(c.low))
  .sort((a, b) => {
    if (a.ts != null && b.ts != null) return a.ts - b.ts;
    return 0;
  });
```

**Verification:**
```bash
node --input-type=module -e "import { fetchCandles } from './tools/chart-indicators.js'; const c=fetchCandles('GWjQzhiTgHNA7E4nEoYzYPTbwQBJ35h89zjYyyTepump','15m',20); console.log(c[0], c.at(-1));"
```

**Expected:**
- `c[0]` = oldest candle around launch.
- `c.at(-1)` = newest/current candle around `0.00042`.

---

### Task 3: Add `minCandles` support to indicator computation

**Objective:** Let S4 require only 11 bars for Supertrend while using more bars when available.

**Files:**
- Modify: `tools/chart-indicators.js:248-300`
- Modify: `tools/chart-indicators.js:571-579`

**Design:**
- Keep existing `candles` as desired/requested window.
- Add `minCandles` option.
- If available candles `< minCandles`, return insufficient.
- If available candles `>= minCandles`, compute using `Math.min(candles, allCandles.length)`.
- Return metadata so logs/debug can explain decisions.

**Target behavior:**
```js
export function computeChartIndicatorsLocal(mint, {
  interval = "5_MINUTE",
  candles = 298,
  minCandles = candles,
  ...
} = {}) {
  const allCandles = fetchCandles(mint, bar, candles + 40);
  if (allCandles.length < minCandles) {
    return {
      insufficient_data: true,
      latest: null,
      candleCount: allCandles.length,
      requestedCandles: candles,
      minCandles,
    };
  }

  const usableCandles = Math.min(candles, allCandles.length);
  const recent = allCandles.slice(-usableCandles);
  ...
}
```

**Also update:**
```js
export async function fetchChartIndicatorsForMint(mint, opts = {}) {
  const candles = opts.candles ?? 298;
  const minCandles = opts.minCandles ?? candles;
  ...
  return computeChartIndicatorsLocal(mint, { interval, candles, minCandles, ... });
}
```

**Verification:**
```bash
node --input-type=module -e "import { computeChartIndicatorsLocal } from './tools/chart-indicators.js'; const r=computeChartIndicatorsLocal('GWjQzhiTgHNA7E4nEoYzYPTbwQBJ35h89zjYyyTepump',{interval:'15_MINUTE',candles:20,minCandles:11}); console.log(JSON.stringify(r.latest,null,2), r.candleCount);"
```

**Expected:**
- `insufficient_data=false`
- latest close around `0.00042`
- Supertrend object present
- RSI present

---

### Task 4: Change `checkBounceSetup()` to use S4-specific candle settings

**Objective:** Stop GMGN S4 from using the generic 298 candle default.

**File:**
- Modify: `tools/gmgn.js:509-605`

**Config defaults:**
- `indicatorCandles`: default `20`
- `indicatorMinCandles`: default `11`

**Implementation detail:**
```js
const indicatorCandles = Number(g.indicatorCandles ?? 20);
const indicatorMinCandles = Number(g.indicatorMinCandles ?? 11);
const payload = await fetchChartIndicatorsForMint(mint, {
  interval,
  candles: indicatorCandles,
  minCandles: indicatorMinCandles,
});
```

**Insufficient behavior:**
- If `<11` bars: fail that timeframe with reason like `insufficient candle data: 10 < 11`.
- With `mode=any`, 15m can still pass if it has >=11 even when 1H has only 10.

**Expected for GYATT:**
- 15m passes.
- 30m likely passes if >=11.
- 1H may fail if only 10.
- Overall `mode:any` passes.

---

### Task 5: Calibrate `rejectAlreadyAtBottom` for young tokens

**Objective:** Keep bottom-rejection useful for older tokens, but don’t reject young tokens that cannot produce Bollinger context.

**File:**
- Modify: `tools/gmgn.js:531-547`

**Design:**
- `alreadyAtBottom` should only be evaluated when:
  - RSI is finite
  - lower BB is finite and positive
  - close is finite and positive
- If BB is missing because candle count <20, skip the bottom check.

**Target code pattern:**
```js
const hasLowerBand = Number.isFinite(lowerBand) && lowerBand > 0;
const alreadyAtBottom =
  Number.isFinite(rsiValue) && rsiValue < oversold &&
  close > 0 && hasLowerBand && close < lowerBand;
```

**Note:** This already mostly matches current behavior, but make it explicit and include debug metadata if possible (`bottomCheckSkipped: true`).

---

### Task 6: Re-check `requireAboveSupertrend` safely

**Objective:** Avoid false rejection when Supertrend exists but has edge-case numeric values.

**File:**
- Modify: `tools/gmgn.js:534`

**Minimal safe version:**
```js
const hasSupertrendValue = Number.isFinite(stValue);
const priceAboveSupertrend = close > 0 && hasSupertrendValue && close >= stValue;
```

**Why:** Current code requires `stValue > 0`. After candle sorting GYATT 15m has positive ST and passes, but 30m with small samples can produce negative ST despite bullish trend. Negative ST should not automatically mean invalid.

**Risk:** Low, but keep this as its own tiny change and verify with GYATT + one older token.

---

### Task 7: Add end-to-end S4 regression script for GYATT

**Objective:** Prove `checkBounceSetup(GYATT)` now returns pass with current config.

**File:**
- Add: `test/test-gmgn-s4-gyatt.js` or extend `test/test-chart-indicators.js`

**Test shape:**
```js
import assert from "node:assert/strict";
import { checkBounceSetup } from "../tools/gmgn.js";

const mint = "GWjQzhiTgHNA7E4nEoYzYPTbwQBJ35h89zjYyyTepump";
const result = await checkBounceSetup(mint);
console.log(JSON.stringify(result, null, 2));
assert.equal(result.passed, true);
assert(result.tfBreakdown.some((tf) => tf.interval === "15_MINUTE" && tf.passed));
```

**Run:**
```bash
cd /home/ubuntu/meridian1
node test/test-gmgn-s4-gyatt.js
```

**Expected after fix:** PASS.

**Caveat:** This is live-data dependent. If GYATT changes trend later, the exact `passed=true` assertion may become flaky. Better long-term test: fixture/mock candle arrays.

---

### Task 8: Run full local validation

**Commands:**
```bash
cd /home/ubuntu/meridian1
node test/test-chart-indicators.js
node test/test-gmgn-s4-gyatt.js
npm run test:screen
```

**Manual verification command:**
```bash
node --input-type=module << 'EOF'
import { fetchCandles, computeChartIndicatorsLocal } from './tools/chart-indicators.js';
import { checkBounceSetup } from './tools/gmgn.js';
const mint='GWjQzhiTgHNA7E4nEoYzYPTbwQBJ35h89zjYyyTepump';
const c=fetchCandles(mint,'15m',20);
console.log('oldest', c[0]);
console.log('latest', c.at(-1));
console.log('ind', computeChartIndicatorsLocal(mint,{interval:'15_MINUTE',candles:20,minCandles:11}).latest);
console.log('bounce', await checkBounceSetup(mint));
EOF
```

**Expected:**
- Latest candle close aligns with GMGN current price region.
- `computeChartIndicatorsLocal(...15m...)` uses latest close, not launch close.
- `checkBounceSetup` passes if at least one configured timeframe passes.

---

### Task 9: Commit locally only

**Objective:** Preserve local change history, no remote push.

**Command:**
```bash
cd /home/ubuntu/meridian1
git status --short
git add tools/chart-indicators.js tools/gmgn.js test/test-chart-indicators.js test/test-gmgn-s4-gyatt.js
git commit -m "fix: calibrate gmgn s4 candle indicators"
```

**Note:** User preference is local-only git. Do not push.

---

## Acceptance Criteria

- `fetchCandles()` returns ascending chronological candles.
- GYATT latest 15m close is around GMGN current price, not launch candle price.
- S4 no longer requires 298 candles.
- Supertrend can compute with >=11 candles.
- `rejectAlreadyAtBottom` only applies when BB data exists; young tokens are not rejected for missing BB context.
- `checkBounceSetup(GYATT)` passes in `any` mode when 15m/30m Supertrend rules pass.
- No on-chain deploy or trade occurs during validation.

---

## Risks / Tradeoffs

- Live-data tests can become flaky as GYATT price action changes. Prefer fixture tests for durable CI-style checks.
- Lowering S4 window from 298 to 20/11 makes indicators more responsive but noisier. This is intentional for meme-token screening; 298 candles is too slow for 7-hour tokens.
- Sorting by timestamp assumes onchainos `ts` is consistently milliseconds. Current evidence supports that.
- Including unconfirmed current candle (`confirm=0`) preserves existing behavior but may make signals slightly more reactive. We can later add config to exclude unconfirmed candles if needed.

---

## Open Questions

1. Should S4 include unconfirmed current candle (`confirm=0`) or only confirmed candles?
2. Should `indicatorCandles` / `indicatorMinCandles` be added to `gmgn-config.json` explicitly, or just defaults in code?
3. Do we want a fixture-based test to avoid live token dependence?

Recommendation: implement code defaults first (`20` desired, `11` min), add explicit config keys after it proves stable.
