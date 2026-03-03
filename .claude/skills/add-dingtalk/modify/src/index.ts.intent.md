# Intent: src/index.ts modifications

## What changed
Added DingTalk channel registration block following the same pattern as Feishu.

## Key sections

### Imports (top of file)
- Added: `DingTalkChannel` from `./channels/dingtalk.js`
- Added: `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET` from `./config.js`

### main() — Channel setup section
- Added: Conditional DingTalk channel creation after Feishu block:
  ```typescript
  if (DINGTALK_APP_KEY && DINGTALK_APP_SECRET) {
    const dingtalk = new DingTalkChannel({ onMessage, onChatMetadata, registeredGroups: () => registeredGroups });
    channels.push(dingtalk);
    await dingtalk.connect();
  }
  ```
- Changed: Error message when no channels configured — now mentions DingTalk alongside WhatsApp and Feishu

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged
- Feishu and WhatsApp channel blocks are unchanged
- All existing channels continue to work identically

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` and `_setChannels` test helpers
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- Shutdown handler with cursor rollback
- Queue notification timers
- IPC watcher and scheduler setup
