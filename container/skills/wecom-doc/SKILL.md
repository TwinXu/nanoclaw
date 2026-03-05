---
name: wecom-doc
description: Manage WeCom (企业微信) Wedrive files and spaces. Use to list spaces, browse files, upload/download files, create documents and folders, and search files in Wedrive.
allowed-tools: Bash(wecom-doc:*)
---

# WeCom Wedrive (微盘)

## Quick start

```bash
wecom-doc spaces                                    # List Wedrive spaces
wecom-doc files <space_id>                          # List files in a space
wecom-doc download <file_id>                        # Download a file
```

## Commands

### List Wedrive spaces

```bash
wecom-doc spaces
```

Returns all accessible Wedrive spaces with their IDs and types.

### List files in a space or folder

```bash
wecom-doc files <space_id>                          # Root-level files
wecom-doc files <space_id> <folder_id>              # Files in a folder
```

### Get file info

```bash
wecom-doc info <file_id>
```

Returns metadata: name, type, size, space, parent, timestamps.

### Download a file

```bash
wecom-doc download <file_id>                        # Download to current directory
wecom-doc download <file_id> /tmp                   # Download to specific directory
```

### Upload a file

```bash
wecom-doc upload <space_id> <folder_id> /path/to/file.pdf
```

### Create a folder

```bash
wecom-doc mkdir <space_id> <folder_id> "Folder Name"
```

### Create a document

```bash
wecom-doc create <space_id> <folder_id> "Doc Title"              # Micro-doc (default)
wecom-doc create <space_id> <folder_id> "Sheet" sheet             # Spreadsheet
wecom-doc create <space_id> <folder_id> "Slides" slide            # Presentation
wecom-doc create <space_id> <folder_id> "Form" form               # Form/survey
```

Supported types: `doc`, `sheet`, `slide`, `form`, `flowchart`, `mindmap`

### Delete a file

```bash
wecom-doc delete <file_id>
```

### Search files

```bash
wecom-doc search "keyword"                          # Search across all spaces
wecom-doc search "keyword" -s <space_id>            # Search within a space
```

## Example: Browse and download

```bash
# 1. Find the space
wecom-doc spaces

# 2. List files
wecom-doc files sp_xxxxxxxxxxxx

# 3. Drill into a folder
wecom-doc files sp_xxxxxxxxxxxx fd_yyyyyyyyyyyy

# 4. Download a file
wecom-doc download fi_zzzzzzzzzzzz
```
