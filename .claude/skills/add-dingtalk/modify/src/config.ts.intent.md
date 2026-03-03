# Intent: src/config.ts modifications

## What changed
Added three new configuration exports for DingTalk channel support.

## Key sections
- **New exports**: `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`, `DINGTALK_ROBOT_CODE` — all read from `process.env`, defaulting to empty string (channel disabled when all empty)
- **Placement**: After the Feishu config block, before channel toggles

## Invariants
- All existing config exports remain unchanged
- No existing behavior is modified — DingTalk config is additive only
- DingTalk keys are read directly from `process.env` (same pattern as Feishu)
- The `readEnvFile` call is NOT modified — DingTalk secrets are read in container-runner.ts, not here

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern for ASSISTANT_NAME and ASSISTANT_HAS_OWN_NUMBER
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
- Feishu config exports
- Channel toggles
