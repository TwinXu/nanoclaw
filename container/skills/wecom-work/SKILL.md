---
name: wecom-work
description: Manage WeCom (企业微信) calendar events and schedule. Use to create/list/update/delete calendar events and create todo reminders.
allowed-tools: Bash(wecom-work:*)
---

# WeCom Work (日程 + 待办)

## Quick start

```bash
wecom-work cal list                                  # List today's events
wecom-work cal create "Team sync" "2025-03-15T14:00" "2025-03-15T15:00"
wecom-work todo create "Review PR" --due 2025-03-20
```

## Calendar

### List events

```bash
wecom-work cal list                                  # Today's events
wecom-work cal list 2025-03-20                       # Events on a specific date
```

### Get event details

```bash
wecom-work cal get <schedule_id>
```

### Create an event

```bash
wecom-work cal create <summary> <start> <end> [--location <loc>] [--description <text>] [--attendees <user1,user2>]
```

Date formats: `2025-03-15`, `2025-03-15T14:00`, ISO 8601

```bash
wecom-work cal create "Sprint review" "2025-03-15T14:00" "2025-03-15T15:00" --location "Meeting Room A"
wecom-work cal create "1:1" "2025-03-16T10:00" "2025-03-16T10:30" --attendees "zhangsan,lisi"
```

### Update an event

```bash
wecom-work cal update <schedule_id> [--summary <s>] [--start <t>] [--end <t>] [--location <loc>] [--description <text>]
```

### Delete an event

```bash
wecom-work cal delete <schedule_id>
```

## Todo

Creates schedule-based reminders (企业微信 does not have a standalone todo API).

### Create a todo

```bash
wecom-work todo create <title> [--due <date>] [--description <text>]
```

```bash
wecom-work todo create "Deploy v2.0" --due 2025-03-20
wecom-work todo create "Write docs" --description "API reference for new endpoints"
```

Todos appear as `[TODO]` prefixed events in your calendar with a 15-minute reminder.
