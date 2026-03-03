---
name: dingtalk-wiki
description: Read DingTalk wiki / knowledge base pages and documents. Use to look up internal documentation, knowledge base articles, and team wikis. Supports listing workspaces, browsing nodes, reading document content, and searching.
allowed-tools: Bash(dingtalk-wiki:*)
---

# DingTalk Wiki Reader

## Quick start

```bash
dingtalk-wiki spaces                                  # List all workspaces
dingtalk-wiki nodes <workspace_id>                    # List top-level nodes
dingtalk-wiki read <workspace_id> <node_id>           # Read document as plain text
```

## Commands

### List workspaces (knowledge bases)

```bash
dingtalk-wiki spaces
```

Returns all accessible workspaces with their IDs.

### List nodes in a workspace

```bash
dingtalk-wiki nodes <workspace_id>                    # Top-level nodes
dingtalk-wiki nodes <workspace_id> -p <node_id>       # Child nodes under a parent
```

Returns node names, IDs, types, and whether they have children. Use `-p` to drill into nested nodes.

### Read a document

```bash
dingtalk-wiki read <workspace_id> <url_or_node_id>
```

Reads a document and outputs its content as plain text. Supports documents and spreadsheets (sheets). Accepts either a full DingTalk docs URL or a node ID.

For spreadsheets, outputs tab-separated values for each sheet (up to 1000 rows per sheet). Multi-sheet spreadsheets show each sheet with a `--- Sheet: name ---` header.

URL formats accepted:
- `https://alidocs.dingtalk.com/i/nodes/ABC123`
- `https://alidocs.dingtalk.com/i/spaces/XYZ/nodes/ABC123`
- Plain node ID: `ABC123`

### Get node info

```bash
dingtalk-wiki node <workspace_id> <url_or_node_id>
```

Returns metadata about a node: name, type, doc key, workspace ID, and parent.

### Search documents

```bash
dingtalk-wiki search <keyword>                        # Search across all workspaces
dingtalk-wiki search <keyword> -w <workspace_id>      # Search within a workspace
```

Searches documents by keyword and returns matching results with their IDs and locations.

## Example: Browse and read a wiki page

```bash
# 1. Find the workspace
dingtalk-wiki spaces

# 2. List nodes in the workspace
dingtalk-wiki nodes WS123456

# 3. Drill into child nodes if needed
dingtalk-wiki nodes WS123456 -p NodeId789

# 4. Read the document
dingtalk-wiki read WS123456 NodeId456
```

## Example: Search and read

```bash
# 1. Search for a topic
dingtalk-wiki search "onboarding guide"

# 2. Read the matching document
dingtalk-wiki read WS123456 NodeId789
```
