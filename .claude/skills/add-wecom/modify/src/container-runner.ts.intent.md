# Intent: src/container-runner.ts modifications

## What changed
Added WeCom secrets to the `readSecrets()` allowlist.

## Key sections

### readSecrets()
- Added five entries to the allowlist array: `'WECOM_RELAY_URL'`, `'WECOM_CORP_ID'`, `'WECOM_AGENT_ID'`, `'WECOM_WS_TOKEN'`, `'WECOM_BOT_WEBHOOK_URL'`
- These are appended after the existing DingTalk entries

## Invariants
- All existing secrets remain in the allowlist
- No other functions are modified
- Volume mount logic is unchanged
- Container spawn logic is unchanged

## Must-keep
- All existing allowlist entries (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_*, ASSISTANT_NAME, FEISHU_*, DINGTALK_*)
- The readEnvFile pattern for reading secrets from .env
- The `delete input.secrets` and `delete input.media` patterns
