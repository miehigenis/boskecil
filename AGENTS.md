<claude-mem-context>
# Memory Context

# [meridian1] recent context, 2026-05-24 4:33pm GMT+7

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (22,000t read) | 426,667t work | 95% savings

### May 18, 2026
482 10:08a ✅ meridian1 post-fix restart confirmed — new screening cycle running with rsi_extreme
483 " 🔴 rsi_extreme confirmed working — meridian1 deployed first position post-fix
489 1:09p 🔵 meridian1 RSI/deploy log investigation — pm2 stream empty, file logs present
490 " 🔵 meridian1 RSI overbought never triggers — strategy deploys below active bin only
491 " 🔵 meridian1 live deploy activity 2026-05-18: Ebola-SOL and HERMES-SOL with close failures
492 1:10p 🔵 rsi_extreme preset defined in chart-indicators.js — accepts both oversold AND overbought for entry
493 1:11p 🔵 user-config.json sets chartIndicators.entryPreset = "rsi_extreme" with custom thresholds (rsiOversold ~20, rsiOverbought ~65)
494 1:12p 🔵 Full chartIndicators config confirmed — 3 intervals including 1_HOUR, rsiOversold=20, rsiOverbought=65
495 " 🔵 RSI overbought DOES trigger rsi_extreme confirmation — pool memory kills overbought candidates, not the indicator filter
497 " 🔵 Agent issued explicit "⛔ NO DEPLOY" on confirmed overbought BABYTROLL-SOL — pool memory override documented verbatim
498 " 🔵 prompt.js and lessons.js contain zero RSI/overbought guidance — LLM overbought rejection is emergent from training knowledge
496 1:13p 🔵 entryPreset changed from fibo_reclaim (2026-05-17) to rsi_extreme (2026-05-18) via agent auto-tune
S223 User asks where LLM gets overbought-rejection reasoning — from prompt.js, lessons.js, or model training knowledge (May 18, 1:15 PM)
S224 Fix meridian1 overbought deploy behavior — LLM was rejecting overbought RSI candidates using emergent training knowledge; fix by adding INDICATOR GATE to SCREENER prompt (May 18, 1:20 PM)
499 1:21p ✅ prompt.js SCREENER section updated — added INDICATOR GATE block to allow overbought deploys
500 " ✅ meridian1 restarted via PM2 to pick up prompt.js INDICATOR GATE change
S225 meridian1 overbought deploy fix — investigate why RSI overbought never triggers deploy, trace root cause, implement and commit fix to SCREENER prompt (May 18, 1:21 PM)
501 1:23p ✅ prompt.js INDICATOR GATE change committed to git — meridian1 repo
S226 Fix silent Telegram close notifications in meridian1 — deterministic rules, /close, /closeall, and exitMap (trailing TP/stop loss) paths (May 18, 1:24 PM)
502 1:38p 🔵 meridian1 telegram.js — notifyClose exists but caller chain unclear
503 " 🔵 Critical diff: experimental notifyClose has hasActiveLiveMessage() guard — local does not
504 1:39p 🔵 index.js confirmed: notifyClose called in all three close paths in meridian1
505 " 🔵 executor.js also calls notifyClose internally — double notification for every close_position call
506 " 🔵 Root cause for experimental branch: liveMessage active during deterministic close → notifyClose silently dropped
508 1:40p 🔵 Experimental branch architecture fundamentally different — /close /closeall bypass executeTool, no notifyClose for command closes
507 1:43p 🔵 executor.js notifyClose is inside if(success) block — fires only on successful close, no liveMessage guard
509 1:44p 🔵 meridian1 management cycle: exitMap CLOSE actions still passed to LLM — LLM without close_position access causes silent failed closes
510 " 🔵 state.js fetchAutoClosedPnLAndNotify has potential broken import — `../config.js` likely wrong path
511 " 🔵 fetchAutoClosedPnLAndNotify has two wrong relative import paths — both outside and inside try block
512 1:47p 🔵 runSafetyChecks has no close_position case — defaults to pass:true, no blocking
513 1:48p 🔵 PnL poll (30s) never closes directly — triggers runManagementCycle(silent:true) which then executes closes without live message
514 " 🔴 Fixed state.js fetchAutoClosedPnLAndNotify — removed dead dead imports blocking auto-close notifications
S239 Audit Meridian bot codebase for all code/prompts that reject new tokens even when they pass gmgn-config or user-config filters (May 18, 1:52 PM)
### May 23, 2026
539 2:10p 🔵 Meridian Token Rejection Mechanisms Mapped
540 2:11p 🔵 Pool Memory Injects Past Notes Into LLM Candidate Blocks
541 " 🔵 Post-Recon Hard Filters in index.js Catch Non-GMGN Tokens
542 " 🔵 Hard Cooldown System in screening.js Blocks Previously-Closed Tokens
543 " 🔵 Exact Cooldown Triggers and Durations in pool-memory.js
S240 Investigate why HENRY-SOL position closed with Telegram reason "not found on-chain" despite expecting deterministic rule close (May 23, 2:13 PM)
544 3:09p 🔵 Meridian Close Reason Mismatch: Deterministic Rule vs "Not Found On-Chain"
545 " 🔵 Meridian "Not Found On-Chain" Close Reason: State Sync Auto-Close Mechanism
546 " 🔵 Meridian Close Reason Resolution: getAutoCloseReason() Fallback Logic Traced
547 3:10p 🔵 Root Cause Found: setCloseReason Uses In-Memory Map, extractDeterministicCloseReason Reads pos.notes — Disconnected
548 " 🔵 extractDeterministicCloseReason() Is Effectively Dead Code — Regex Pattern Never Matches Any Written Note
549 3:11p 🔵 Complete Close Reason Chain Traced: recordClose() Is the Key Link That Sync Bypasses
550 " 🔵 Definitive Root Cause: syncOpenPositions Runs INSIDE getMyPositions(), Before Deterministic Rules
551 " 🔵 Confirmed: Deterministic Close Always Succeeds On-Chain — Bug Is Telegram Notification Reason Only
S241 Debug why HENRY-SOL Telegram close notification showed "not found on-chain" instead of actual deterministic rule reason (May 23, 3:11 PM)
S243 Fix chart-indicators.js to support 30m and 1H indicator timeframes (user said "fix") (May 23, 4:03 PM)
552 4:03p 🔵 notifyClose Has hasActiveLiveMessage() Guards — Deterministic Close Notification Silently Suppressed During LLM Turn
553 " 🔵 Correction: notifyClose() Has NO hasActiveLiveMessage() Guard — Previous Theory Wrong
554 4:04p 🔵 Management Cycle Protected by _managementBusy Flag — Concurrent Cycles Not the Cause
556 " 🔵 Definitive Root Cause: getMyPositions() Called Inside closePosition() for Verification — Triggers syncOpenPositions Mid-Close
557 " 🔴 Fix Applied: getMyPositions() Gains skipSync Parameter to Suppress syncOpenPositions During Close Verification
555 " 🔵 pnlPollInterval Runs Every 30s and Calls getMyPositions() — Another syncOpenPositions Trigger
### May 24, 2026
558 10:01a 🔵 gmgn-config.json indicator and kline timeframe fields clarified
559 " 🔵 chart-indicators.js only supports 1m/5m/15m — 30m and 1h silently dropped
560 " 🔵 onchainos CLI supports 30m and 1H bar sizes natively
S244 Fix — extend chart-indicators.js to support 30m and 1H timeframes in meridian1 (May 24, 10:01 AM)
S242 Extend chart-indicators.js to support 30m and 1H indicator timeframes in meridian1 (May 24, 10:04 AM)
**Investigated**: - gmgn-config.json: full config structure, current indicatorIntervals = ["15_MINUTE", "1_HOUR"], klineResolution = "5m"
    - chart-indicators.js: BAR_MAP (lines 20-25), normalizeIntervals() (line 302-306), fetchCandles() function
    - onchainos CLI: confirmed supported bar values via --help

**Learned**: - Two separate timeframe concepts: klineResolution (raw candle fetch for volume analysis) vs indicatorIntervals (technical indicator computation timeframes)
    - normalizeIntervals() hard-whitelist at line 306 only passes "1_MINUTE", "5_MINUTE", "15_MINUTE" — anything else silently dropped
    - Current config has "1_HOUR" in indicatorIntervals but it's been silently ignored this whole time — only 15m actually runs
    - onchainos CLI supports: 1s, 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W — 30m and 1H are valid
    - Critical gotcha: 1-hour bar string is "1H" (uppercase H), not "1h"

**Completed**: No code changes yet. Investigation phase complete.

**Next Steps**: User confirmed intent. Next: edit chart-indicators.js to add "30_MINUTE": "30m" and "1_HOUR": "1H" to BAR_MAP, extend normalizeIntervals filter to include "30_MINUTE" and "1_HOUR", then update gmgn-config.json indicatorIntervals to ["30_MINUTE", "1_HOUR"].


Access 427k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>