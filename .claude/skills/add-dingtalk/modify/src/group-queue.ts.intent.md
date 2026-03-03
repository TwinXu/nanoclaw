# Intent: src/group-queue.ts modifications

## What changed
Extended `sendMessage()` to accept optional media attachments for IPC delivery.

## Key sections

### Import
- Added: `MediaAttachment` from `./container-runner.js`

### sendMessage()
- Added: optional `media?: MediaAttachment[]` parameter
- When media is present, includes it in the IPC JSON payload: `{ type: 'message', text, media }`
- When no media, payload is unchanged: `{ type: 'message', text }`

## Invariants
- All existing GroupQueue methods are unchanged
- Queue scheduling, shutdown, and process management are unchanged
- The IPC file write pattern (atomic rename) is preserved

## Must-keep
- The atomic write pattern (write to .tmp, rename to .json)
- The `state.idleWaiting = false` reset
- All existing queue management methods
