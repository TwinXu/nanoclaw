---
name: feishu-wiki
description: Read Feishu/Lark wiki pages and documents. Use to look up internal documentation, knowledge base articles, and team wikis. Supports listing spaces, browsing pages, and reading document content as plain text.
allowed-tools: Bash(feishu-wiki:*)
---

# Feishu Wiki Reader

## Quick start

```bash
feishu-wiki spaces                          # List all wiki spaces
feishu-wiki pages <space_id>                # List top-level pages
feishu-wiki read <url_or_token>             # Read document as plain text
```

## Commands

### List wiki spaces

```bash
feishu-wiki spaces
```

Returns all accessible wiki spaces with their IDs.

### List pages in a space

```bash
feishu-wiki pages <space_id>                # Top-level pages
feishu-wiki pages <space_id> -p <token>     # Child pages under a node
```

Returns page titles, tokens, types, and whether they have children. Use `-p` to drill into nested pages.

### Read a document

```bash
feishu-wiki read <url_or_token>
```

Reads a docx document and outputs its content as plain text. Accepts either a full Feishu URL or a wiki node token.

URL formats accepted:
- `https://org.feishu.cn/wiki/ABC123`
- `https://org.larksuite.com/wiki/ABC123`
- Plain token: `ABC123`

### Get node info

```bash
feishu-wiki node <url_or_token>
```

Returns metadata about a wiki node: title, type, document token, space ID, and parent.

## Example: Browse and read a wiki page

```bash
# 1. Find the space
feishu-wiki spaces

# 2. List pages in the space
feishu-wiki pages 7123456789

# 3. Drill into child pages if needed
feishu-wiki pages 7123456789 -p NodeToken123

# 4. Read the document
feishu-wiki read NodeToken456
```

## Example: Read a page from a URL

```bash
feishu-wiki read "https://myorg.feishu.cn/wiki/ABC123XYZ"
```
