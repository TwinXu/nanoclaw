# Intent: src/index.ts modifications

## What changed
Added WeCom channel registration block following the same pattern as DingTalk.

## Key sections

### Imports (top of file)
- Added: `WeComChannel` from `./channels/wecom.js`
- Added: `WECOM_RELAY_URL`, `WECOM_CORP_ID` from `./config.js`

### main() — Channel setup section
- Added: Conditional WeCom channel creation after DingTalk block
- Condition: `WECOM_RELAY_URL && WECOM_CORP_ID` (both must be set)
- Changed: Error message when no channels configured — now mentions WeCom

## Invariants
- All existing message processing logic is preserved
- State management is unchanged
- Recovery logic is unchanged
- All existing channels continue to work identically
- Shutdown handler is unchanged

## Must-keep
- All existing channel blocks (WhatsApp, Feishu, DingTalk)
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` and `_setChannels` test helpers
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic
