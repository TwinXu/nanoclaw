---
name: add-dingtalk
description: Add DingTalk as a channel via Stream Mode (WebSocket, no public IP needed). Supports group chats and DMs with markdown passthrough.
---

# Add DingTalk Channel

This skill adds DingTalk (钉钉) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

DingTalk Stream Mode uses WebSocket — no public IP or webhook URL is required.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `dingtalk` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to confirm:

AskUserQuestion: Do you have a DingTalk enterprise internal app with robot capability, or do you need to create one?

If they have one, collect the AppKey and AppSecret now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-dingtalk
```

This deterministically:
- Adds `src/channels/dingtalk.ts` (DingTalkChannel class implementing Channel interface)
- Adds `src/channels/dingtalk.test.ts` (unit tests)
- Three-way merges DingTalk support into `src/index.ts` (channel registration block)
- Three-way merges DingTalk config into `src/config.ts` (DINGTALK_APP_KEY, DINGTALK_APP_SECRET, DINGTALK_ROBOT_CODE)
- Three-way merges DingTalk secrets into `src/container-runner.ts` (readSecrets allowlist)
- Installs the `dingtalk-stream` npm dependency
- Updates `.env.example` with DingTalk environment variables
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts
- `modify/src/container-runner.ts.intent.md` — what changed for container-runner.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new dingtalk tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create DingTalk App (if needed)

If the user doesn't have an app, tell them:

> I need you to create a DingTalk enterprise internal app:
>
> 1. Go to the [DingTalk Developer Console](https://open-dev.dingtalk.com/)
> 2. Click **Create Application** (创建应用) → choose **Enterprise Internal** (企业内部应用)
> 3. Give it a name (e.g., "Andy Assistant") and a description
> 4. Under **Application Capabilities** (应用能力), add **Robot** (机器人)
> 5. In the Robot configuration:
>    - Select **Stream Mode** (Stream 模式) — this is critical, NOT webhook mode
>    - Optionally set a bot avatar
> 6. Under **Permissions** (权限管理), search for and enable: `qyapi_robot_sendmsg`
> 7. **Publish** the app (发布) — you can use a test version first
> 8. Go to **Credentials & Basic Information** (凭证与基本信息)
> 9. Copy the **AppKey** (Client ID) and **AppSecret** (Client Secret)

Wait for the user to provide AppKey and AppSecret.

### Get Robot Code

Tell the user:

> Also, I need the Robot Code (robotCode):
>
> In the DingTalk Developer Console, go to your app's **Robot** configuration page.
> The Robot Code is typically the same as your AppKey, but verify it on the robot config page.

### Configure environment

Add to `.env`:

```bash
DINGTALK_APP_KEY=<their-app-key>
DINGTALK_APP_SECRET=<their-app-secret>
DINGTALK_ROBOT_CODE=<their-robot-code>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Conversation ID

Tell the user:

> 1. Add the bot to a DingTalk group chat
> 2. @mention the bot with any message (e.g., "@Andy hello")
> 3. Check the NanoClaw logs — the conversation ID will appear in metadata:
>    ```bash
>    tail -f logs/nanoclaw.log | grep dingtalk
>    ```
>    Look for a line like: `DingTalk message stored` or `onChatMetadata` with a JID like `cid...@dingtalk`
> 4. Copy the conversation ID (the part before `@dingtalk`)

Wait for the user to provide the conversation ID.

For DMs: Have the user send a direct message to the bot, then find the conversation ID in logs the same way.

### Register the chat

The conversation ID and folder name are needed.

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("<conversationId>@dingtalk", {
  name: "<chat-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional group chats (trigger-only):

```typescript
registerGroup("<conversationId>@dingtalk", {
  name: "<chat-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

For DM (1:1) chats — **must use `requiresTrigger: false`** since DM messages don't include the @mention trigger:

```typescript
registerGroup("<conversationId>@dingtalk", {
  name: "<user-name> DM",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered DingTalk chat:
> - For main chat: Any message @mentioning the bot works
> - For non-main: @mention the bot with your message
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `DINGTALK_APP_KEY` and `DINGTALK_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. The app uses **Stream Mode** (not webhook mode) in the DingTalk Developer Console
3. The app is **published** (发布) — draft apps won't receive messages
4. The `qyapi_robot_sendmsg` permission is enabled
5. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE '%@dingtalk'"`
6. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Messages not arriving

- DingTalk Stream mode requires the app to be an **enterprise internal** app
- The robot must have **Stream Mode** selected (not HTTP webhook)
- Check if the WebSocket connection is established: look for "Connected to DingTalk (Stream Mode)" in logs

### Send failures

DingTalk uses two send methods:
1. **sessionWebhook** (primary): cached from incoming messages, expires after ~2 hours, no auth needed
2. **OpenAPI** (fallback): uses access token, requires `DINGTALK_ROBOT_CODE` to be set

If sends fail with "token expired" or "access denied":
- Verify `DINGTALK_ROBOT_CODE` is correct (usually same as AppKey)
- Check `qyapi_robot_sendmsg` permission is enabled

### Getting conversation ID

If you can't find the conversation ID in logs:
1. Make sure the bot is added to the group
2. @mention the bot to trigger a message delivery
3. Check logs with: `grep -i "dingtalk\|conversationId" logs/nanoclaw.log`

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove DingTalk integration:

1. Delete `src/channels/dingtalk.ts` and `src/channels/dingtalk.test.ts`
2. Remove `DingTalkChannel` import and creation block from `src/index.ts`
3. Remove DingTalk config (`DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`, `DINGTALK_ROBOT_CODE`) from `src/config.ts`
4. Remove DingTalk secrets from `readSecrets()` in `src/container-runner.ts`
5. Remove DingTalk registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE '%@dingtalk'"`
6. Uninstall: `npm uninstall dingtalk-stream`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
