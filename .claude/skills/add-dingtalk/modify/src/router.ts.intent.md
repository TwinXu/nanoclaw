# Intent: src/router.ts modifications

## What changed
Added image reference parsing and stripping helpers for media pre-download.

## Key sections

### parseImageRefs(content)
- Extracts `[图片 image_key=xxx message_id=yyy]` refs from message content
- Returns array of `{ imageKey, messageId, fullMatch }`
- Uses local regex (not module-level) to avoid stale `lastIndex` bugs

### stripImageRefs(content, downloadedKeys)
- Replaces successfully downloaded image refs with `[图片]`
- Keeps failed refs with full metadata intact for MCP `view_image` fallback

### ImageRef interface
- Exported type for parsed image references

## Invariants
- All existing functions (`formatMessages`, `escapeXml`, `formatOutbound`, `routeOutbound`, `findChannel`) are unchanged
- No existing exports are modified

## Must-keep
- All existing router functions
- The `Channel` and `NewMessage` imports from types
