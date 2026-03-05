---
name: add-wecom
description: Add WeCom (企业微信) as a channel via wecom-relay WebSocket bridge. Supports Bot + Agent dual-mode — Agent callback for receiving, Bot webhook for sending.
---

# Add WeCom Channel

This skill adds WeCom (企业微信) support to NanoClaw. Unlike DingTalk/Feishu which have native WebSocket SDKs, WeCom requires a relay service (`wecom-relay`) to bridge HTTP callbacks to WebSocket.

Architecture: Bot + Agent dual-mode fusion
- **Agent mode (receive):** WeCom callback → wecom-relay → WebSocket → NanoClaw
- **Bot mode (send, optional):** NanoClaw → Bot Webhook URL → WeCom group
- **Agent mode (send, fallback):** NanoClaw → WebSocket → wecom-relay proxy → WeCom API

## Prerequisites

The user must have `wecom-relay` deployed and accessible. This is a separate service that:
1. Receives encrypted HTTP callbacks from WeCom
2. Decrypts and forwards messages via WebSocket to NanoClaw
3. Proxies API calls from NanoClaw back to WeCom (with access_token management)

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `wecom` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to confirm:

AskUserQuestion: Do you have wecom-relay deployed and a WeCom enterprise app (自建应用) configured, or do you need help setting up?

Collect the following if they have them ready:
- Relay URL (e.g., `wss://relay.example.com`)
- Corp ID (企业ID)
- Agent ID (应用AgentId)
- WS Token (the token configured in wecom-relay for this app)
- Bot Webhook URL (optional, for group message sending)

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-wecom
```

This deterministically:
- Adds `src/channels/wecom.ts` (WeComChannel class implementing Channel interface)
- Three-way merges WeCom support into `src/index.ts` (channel registration block)
- Three-way merges WeCom config into `src/config.ts` (WECOM_RELAY_URL, WECOM_CORP_ID, etc.)
- Three-way merges WeCom secrets into `src/container-runner.ts` (readSecrets allowlist)
- Installs the `ws` npm dependency
- Updates `.env.example` with WeCom environment variables
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts
- `modify/src/container-runner.ts.intent.md` — what changed for container-runner.ts

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Deploy wecom-relay (if needed)

If the user doesn't have wecom-relay deployed, tell them:

> I need you to deploy the wecom-relay service first. It's a lightweight Go service that bridges WeCom HTTP callbacks to WebSocket.
>
> 1. Clone the repo: `git clone https://github.com/YanHaidao/wecom-relay`
> 2. Set environment variables:
>    - `ADMIN_TOKEN` — a secret token for the admin API
>    - `LISTEN` — listen address (default `:8080`)
> 3. Deploy to any server with a public IP (or use a tunnel)
> 4. Register your WeCom app via the admin API:
>    ```bash
>    curl -X POST https://your-relay/admin/apps \
>      -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
>      -H "Content-Type: application/json" \
>      -d '{
>        "corp_id": "YOUR_CORP_ID",
>        "agent_id": "YOUR_AGENT_ID",
>        "token": "CALLBACK_TOKEN",
>        "encoding_aes_key": "YOUR_43_CHAR_KEY",
>        "app_secret": "YOUR_APP_SECRET",
>        "callback_path": "/callback/myapp",
>        "ws_token": "A_TOKEN_FOR_NANOCLAW"
>      }'
>    ```
> 5. In the WeCom admin console, set the callback URL to: `https://your-relay/callback/myapp`

### Create WeCom App (if needed)

If the user doesn't have an app, tell them:

> I need you to create a WeCom enterprise app (自建应用):
>
> 1. Go to the [WeCom Admin Console](https://work.weixin.qq.com/wework_admin/frame#apps)
> 2. Click **Create App** (创建应用) under **Self-built** (自建)
> 3. Give it a name and description
> 4. Note the **AgentId** on the app detail page
> 5. Under **Receive Messages** (接收消息), set:
>    - URL: `https://your-relay/callback/myapp`
>    - Token: same as `token` in relay config
>    - EncodingAESKey: same as `encoding_aes_key` in relay config
>    - Click **Save** — WeCom will verify the URL via the relay
> 6. Under **Enterprise Trusted IP** (企业可信IP), add the relay server's IP
> 7. Go to **Corp ID** page to get your Corp ID (企业ID)

### Set up Bot Webhook (optional, for group sending)

> For group message sending via Bot webhook (simpler, no auth needed):
>
> 1. In a WeCom group chat, click **...** → **Add Group Bot** (添加群机器人)
> 2. Create a new bot or use an existing one
> 3. Copy the Webhook URL (looks like: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`)
>
> This is optional — without it, group messages will be sent via the Agent API through the relay.

### Configure environment

Add to `.env`:

```bash
WECOM_RELAY_URL=wss://your-relay.example.com
WECOM_CORP_ID=ww1234567890abcdef
WECOM_AGENT_ID=1000001
WECOM_WS_TOKEN=your-ws-token
WECOM_BOT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID / User ID

Tell the user:

> 1. Send a message to the bot in WeCom (either in a group or DM)
> 2. Check the NanoClaw logs for the JID:
>    ```bash
>    tail -f logs/nanoclaw.log | grep wecom
>    ```
>    Look for a line with a JID like `wrk...@wecom` (group) or `UserId@wecom` (DM)
> 3. Copy the JID

### Register the chat

For a main chat:

```typescript
registerGroup("<chatId>@wecom", {
  name: "<chat-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional group chats (trigger-only):

```typescript
registerGroup("<chatId>@wecom", {
  name: "<chat-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

For DM (1:1) chats:

```typescript
registerGroup("<userId>@wecom", {
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

> Send a message to your registered WeCom chat. The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `wecom-relay` is running and accessible
2. WebSocket connection is established: look for "Connected to WeCom relay" in logs
3. `WECOM_RELAY_URL` and `WECOM_WS_TOKEN` are correct in `.env` AND synced to `data/env/env`
4. The WeCom app callback URL is verified (green checkmark in admin console)
5. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE '%@wecom'"`

### Messages not arriving

- Check wecom-relay logs for callback_recv events
- Verify the relay's admin API shows your app: `curl -H "Authorization: Bearer TOKEN" https://relay/admin/apps`
- Check WebSocket connections: `curl -H "Authorization: Bearer TOKEN" https://relay/admin/connections`
- Ensure the WeCom app has the correct permissions (接收消息 enabled)

### Send failures

WeCom uses dual-mode sending:
1. **Bot Webhook** (primary for groups): no auth needed, but only works for the specific group where the bot is added
2. **Agent API** (fallback): proxied through relay, works for any user/group the app has access to

If Bot webhook fails, check the webhook URL is correct and the bot is still in the group.
If Agent API fails, check relay logs for api_proxy errors.

### Relay connection drops

The channel auto-reconnects with exponential backoff (1s → 60s max). If it keeps disconnecting:
- Check relay server health
- Verify `ws_token` matches between `.env` and relay config
- Check for network/firewall issues between NanoClaw and relay

## Removal

To remove WeCom integration:

1. Delete `src/channels/wecom.ts`
2. Remove `WeComChannel` import and creation block from `src/index.ts`
3. Remove WeCom config from `src/config.ts`
4. Remove WeCom secrets from `readSecrets()` in `src/container-runner.ts`
5. Remove WeCom registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE '%@wecom'"`
6. Uninstall: `npm uninstall ws @types/ws`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
