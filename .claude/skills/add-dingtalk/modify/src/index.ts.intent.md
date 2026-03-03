# Intent: src/index.ts modifications

## What changed
1. Added DingTalk channel registration block following the same pattern as Feishu.
2. Added media pre-download infrastructure for vision content blocks.

## Key sections

### Imports (top of file)
- Added: `os` from node builtins
- Added: `DingTalkChannel` from `./channels/dingtalk.js`
- Added: `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET` from `./config.js`
- Added: `MediaAttachment` from `./container-runner.js`
- Added: `parseImageRefs`, `stripImageRefs` from `./router.js`

### preDownloadImages() helper (before processGroupMessages)
- New function that extracts `[图片 image_key=... message_id=...]` refs from messages
- Downloads images via `channel.downloadMedia()` in parallel (`Promise.allSettled`)
- Converts to base64 `MediaAttachment` objects with 5MB size limit
- Strips downloaded refs from message content; keeps failed ones for MCP fallback
- Returns `{ media, strippedMessages }`

### processGroupMessages()
- Calls `preDownloadImages()` before `formatMessages()`
- Passes `media` array through `runAgent()` → `runContainerAgent()`

### startMessageLoop() — piping path
- Calls `preDownloadImages()` before formatting piped messages
- Passes media to `queue.sendMessage()` for IPC delivery

### runAgent()
- Added optional `media?: MediaAttachment[]` parameter
- Passes `media` into `ContainerInput`

### main() — Channel setup section
- Added: Conditional DingTalk channel creation after Feishu block
- Changed: Error message when no channels configured — now mentions DingTalk

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
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
