---
name: dingtalk-wiki
description: Read DingTalk wiki / knowledge base pages and documents. Use to look up internal documentation, knowledge base articles, and team wikis. Supports listing workspaces, browsing nodes, reading document content, and searching.
allowed-tools: Bash(dingtalk-wiki:*)
---

# DingTalk Wiki Reader

## Quick start

```bash
dingtalk-wiki spaces                                  # List all workspaces (shows rootNodeId)
dingtalk-wiki nodes <root_node_id>                    # List top-level nodes
dingtalk-wiki read <node_id>                          # Read document or download file (auto-detects)
dingtalk-wiki download <node_id>                      # Download file (PDF, Word, image, etc.)
```

## Commands

### List workspaces (knowledge bases)

```bash
dingtalk-wiki spaces
```

Returns all accessible workspaces with their IDs and root node IDs. Use the `rootNodeId` as the parent for listing nodes.

### List nodes

```bash
dingtalk-wiki nodes <parent_node_id>
```

Lists child nodes under a parent. For top-level nodes, use the `rootNodeId` from the `spaces` command. Returns node names, IDs, categories, and whether they have children.

### Read a document or file

```bash
dingtalk-wiki read <url_or_node_id>
```

Smart reader that auto-detects the node type:
- **ALIDOC** (DingTalk document): reads and outputs content as plain text
- **ALIDOC_SHEET** (spreadsheet): outputs tab-separated values (up to 1000 rows per sheet)
- **DOCUMENT/IMAGE/ARCHIVE/etc.** (uploaded files like PDF, Word, images): automatically downloads to current directory

URL formats accepted:
- `https://alidocs.dingtalk.com/i/nodes/ABC123`
- `https://alidocs.dingtalk.com/i/spaces/XYZ/nodes/ABC123`
- Plain node ID: `ABC123`

### Download a file

```bash
dingtalk-wiki download <url_or_node_id>              # Download to current directory
dingtalk-wiki download <url_or_node_id> /tmp         # Download to specific directory
```

Downloads a file (PDF, Word, Excel, image, etc.) from the knowledge base. Use this for non-ALIDOC nodes.

### Get node info

```bash
dingtalk-wiki node <url_or_node_id>
```

Returns metadata about a node: name, category, workspace ID, and URL.

### Search documents

```bash
dingtalk-wiki search <keyword>                        # Search across all workspaces
dingtalk-wiki search <keyword> -w <workspace_id>      # Search within a workspace
```

Searches documents by keyword and returns matching results with their IDs and locations.

## Example: Browse and read a wiki page

```bash
# 1. Find the workspace and its root node
dingtalk-wiki spaces

# 2. List top-level nodes using rootNodeId from step 1
dingtalk-wiki nodes RootNodeId123

# 3. Drill into child nodes if needed
dingtalk-wiki nodes ChildNodeId456

# 4. Read the document
dingtalk-wiki read DocNodeId789
```

## Example: Search and read

```bash
# 1. Search for a topic
dingtalk-wiki search "onboarding guide"

# 2. Read the matching document
dingtalk-wiki read NodeId789
```
