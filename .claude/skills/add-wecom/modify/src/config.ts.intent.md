# Intent: src/config.ts modifications

## What changed
Added five new configuration exports for WeCom channel support.

## Key sections
- **New exports**: `WECOM_RELAY_URL`, `WECOM_CORP_ID`, `WECOM_AGENT_ID`, `WECOM_WS_TOKEN`, `WECOM_BOT_WEBHOOK_URL` — all read from `process.env` with `envConfig` fallback, defaulting to empty string (channel disabled when RELAY_URL and CORP_ID are both empty)
- **readEnvFile call**: Updated to include the five new WeCom keys
- **Placement**: After the DingTalk config block, before channel toggles

## Invariants
- All existing config exports remain unchanged
- No existing behavior is modified — WeCom config is additive only
- The `readEnvFile` pattern is extended, not replaced
- DingTalk and Feishu config blocks are unchanged

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern for ASSISTANT_NAME and ASSISTANT_HAS_OWN_NUMBER
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
- Feishu and DingTalk config exports
- Channel toggles
