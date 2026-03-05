---
name: dingtalk-wiki
description: Read and write DingTalk wiki / knowledge base pages and documents. Use to look up internal documentation, knowledge base articles, team wikis, upload files, and create new documents.
allowed-tools: Bash(dingtalk-wiki:*)
---

# DingTalk Wiki

## Quick start

```bash
dingtalk-wiki spaces                                  # List all workspaces (shows rootNodeId)
dingtalk-wiki nodes <root_node_id>                    # List top-level nodes
dingtalk-wiki read <node_id>                          # Read document or download file (auto-detects)
dingtalk-wiki search "keyword"                        # Search documents
```

## Read Commands

### List workspaces (knowledge bases)

```bash
dingtalk-wiki spaces
```

Returns all accessible workspaces with their IDs and root node IDs. Use the `rootNodeId` as the parent for listing nodes.

### List nodes

```bash
dingtalk-wiki nodes <parent_node_id>
```

Lists child nodes under a parent. For top-level nodes, use the `rootNodeId` from the `spaces` command.

### Read a document or file

```bash
dingtalk-wiki read <url_or_node_id>
```

Smart reader that auto-detects the node type:
- **ALIDOC** (DingTalk document): reads and outputs content as plain text
- **ALIDOC_SHEET** (spreadsheet): outputs tab-separated values (up to 1000 rows per sheet)
- **DOCUMENT/IMAGE/ARCHIVE/etc.** (uploaded files): automatically downloads to current directory

### Download a file

```bash
dingtalk-wiki download <url_or_node_id>              # Download to current directory
dingtalk-wiki download <url_or_node_id> /tmp         # Download to specific directory
```

### Get node info

```bash
dingtalk-wiki node <url_or_node_id>
```

### Search documents

```bash
dingtalk-wiki search <keyword>                        # Search across all workspaces
dingtalk-wiki search <keyword> -w <workspace_id>      # Search within a workspace
```

## Write Commands

### Upload a file

```bash
dingtalk-wiki upload <parent_node_id> /path/to/file.pdf
```

Uploads a local file to the specified wiki node. The file appears as a child of the parent node.

### Create a new document

```bash
dingtalk-wiki create <parent_node_id> "Document Title"
```

Creates an empty ALIDOC document under the parent node. Returns the new node ID and URL.

### Create a folder

```bash
dingtalk-wiki mkdir <parent_node_id> "Folder Name"
```

### Write / append to a document

```bash
dingtalk-wiki write <node_id> "New content"           # Overwrite document content
dingtalk-wiki append <node_id> "Additional content"   # Append to existing document
```

## URL formats accepted

- `https://alidocs.dingtalk.com/i/nodes/ABC123`
- `https://alidocs.dingtalk.com/i/spaces/XYZ/nodes/ABC123`
- Plain node ID: `ABC123`

## Beyond Wiki: Other DingTalk APIs

If you need DingTalk capabilities not covered by this tool or `dingtalk-work` (e.g., contacts, workflow/approvals, attendance, HR, CRM, search), you can discover and call them via the `@alicloud/dingtalk` SDK.

### SDK Investigation Method

1. Install the SDK (one-time, in the container):
   ```bash
   cd /tmp && npm install @alicloud/dingtalk 2>&1 | tail -1
   ```

2. List available API modules:
   ```bash
   ls /tmp/node_modules/@alicloud/dingtalk/dist-cjs/ | head -40
   ```
   Modules follow the pattern `{domain}_{version}` (e.g., `contact_1_0`, `workflow_1_0`, `attendance_1_0`).

3. Read the client to find available methods:
   ```bash
   cat /tmp/node_modules/@alicloud/dingtalk/dist-cjs/contact_1_0/client.d.ts
   ```

4. Check request/response types for parameters:
   ```bash
   cat /tmp/node_modules/@alicloud/dingtalk/dist-cjs/contact_1_0/models/*.d.ts
   ```

5. Call the API using the auth pattern from this tool — get an access token via `/v1.0/oauth2/accessToken` with `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET`, then call `https://api.dingtalk.com/v1.0/...` with header `x-acs-dingtalk-access-token`.
