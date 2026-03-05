---
name: dingtalk-work
description: Manage DingTalk todos and calendar events. Use to create/list/complete todos and create/list/delete calendar events.
allowed-tools: Bash(dingtalk-work:*)
---

# DingTalk Work (Todo + Calendar)

## Quick start

```bash
dingtalk-work todo list                              # List pending todos
dingtalk-work cal list                               # List today's events
dingtalk-work todo create "Review PR" --due 2025-03-20 --priority important
dingtalk-work cal create "Team sync" "2025-03-15T14:00" "2025-03-15T15:00"
```

## Todo

### List todos

```bash
dingtalk-work todo list                              # Pending todos
dingtalk-work todo list --done                       # Completed todos
```

### Create a todo

```bash
dingtalk-work todo create <subject> [--due <date>] [--priority <level>] [--description <text>]
```

Priority levels: `low`, `normal`, `important`, `urgent`

```bash
dingtalk-work todo create "Deploy v2.0" --due 2025-03-20 --priority urgent
dingtalk-work todo create "Write docs" --description "API reference for new endpoints"
```

### Complete / delete a todo

```bash
dingtalk-work todo complete <task_id>
dingtalk-work todo delete <task_id>
```

## Calendar

### List events

```bash
dingtalk-work cal list                               # Today's events
dingtalk-work cal list 2025-03-20                    # Events on a specific date
```

### Create an event

```bash
dingtalk-work cal create <summary> <start> <end> [--location <loc>] [--description <text>] [--tz <timezone>]
```

Date formats: `2025-03-15`, `2025-03-15T14:00`, ISO 8601

```bash
dingtalk-work cal create "Sprint review" "2025-03-15T14:00" "2025-03-15T15:00" --location "Meeting Room A"
```

### Delete an event

```bash
dingtalk-work cal delete <event_id>
```
