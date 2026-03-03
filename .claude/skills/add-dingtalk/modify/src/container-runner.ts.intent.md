# Intent: src/container-runner.ts modifications

## What changed
Added DingTalk secrets to the `readSecrets()` allowlist.

## Key sections

### readSecrets()
- Added three entries to the allowlist array: `'DINGTALK_APP_KEY'`, `'DINGTALK_APP_SECRET'`, `'DINGTALK_ROBOT_CODE'`
- These are appended after the existing Feishu entries

## Invariants
- All existing secrets remain in the allowlist
- No other functions are modified
- Volume mount logic is unchanged
- Container spawn logic is unchanged

## Must-keep
- All existing allowlist entries (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_*, ASSISTANT_NAME, FEISHU_*)
- The readEnvFile pattern for reading secrets from .env
