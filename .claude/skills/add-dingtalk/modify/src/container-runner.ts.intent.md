# Intent: src/container-runner.ts modifications

## What changed
1. Added DingTalk secrets to the `readSecrets()` allowlist.
2. Added `MediaAttachment` interface and `media` field to `ContainerInput`.
3. Added `delete input.media` after stdin write to prevent media in logs.

## Key sections

### MediaAttachment interface (before ContainerInput)
- New interface: `{ data: string; mediaType: string }` for base64-encoded images

### ContainerInput
- Added: `media?: MediaAttachment[]` optional field

### readSecrets()
- Added three entries to the allowlist array: `'DINGTALK_APP_KEY'`, `'DINGTALK_APP_SECRET'`, `'DINGTALK_ROBOT_CODE'`
- These are appended after the existing Feishu entries

### stdin write section
- Added: `delete input.media` alongside `delete input.secrets` to prevent megabytes of base64 data in log files

## Invariants
- All existing secrets remain in the allowlist
- No other functions are modified
- Volume mount logic is unchanged
- Container spawn logic is unchanged

## Must-keep
- All existing allowlist entries (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_*, ASSISTANT_NAME, FEISHU_*)
- The readEnvFile pattern for reading secrets from .env
- The `delete input.secrets` pattern (media deletion follows same pattern)
