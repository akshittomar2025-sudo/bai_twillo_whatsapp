# bAI Twilio WhatsApp MCP

One Render service does both jobs:

1. Receives real WhatsApp messages from Twilio Sandbox.
2. Exposes them to bAI as MCP tools inside AgenticOrg.

## MCP tools

- `get_latest_whatsapp_message`
- `list_recent_whatsapp_messages`
- `mark_whatsapp_message_processed`
- `send_whatsapp_message`

For voice notes, `get_latest_whatsapp_message` also returns a public proxy URL that
your existing Gnani MCP can transcribe.

## Deploy

Create a new GitHub repo and upload these four files at the repository root.

Deploy it on Render as a Blueprint or Web Service.

Add these environment variables:

- `TWILIO_ACCOUNT_SID` = from Twilio Console
- `TWILIO_AUTH_TOKEN` = from Twilio Console
- `TWILIO_WHATSAPP_FROM` = your Twilio sandbox WhatsApp number, e.g. `whatsapp:+1XXXXXXXXXX`
- `PUBLIC_BASE_URL` = your final Render URL, e.g. `https://bai-twilio-whatsapp-mcp.onrender.com`

After the first deployment you may need to copy the Render service URL into
`PUBLIC_BASE_URL` and redeploy.

## Twilio setup

In **Try out WhatsApp -> Receive a message -> Custom**:

Webhook URL:

`https://<your-render-url>.onrender.com/webhook/whatsapp`

Request method: **HTTP POST**

Save.

## AgenticOrg setup

Register a new MCP connector:

- Connector name: `twilio_whatsapp_bai_<your_suffix>`
- MCP: ON
- MCP Server URL:
  `https://<your-render-url>.onrender.com/mcp`
- Category: Comms
- Auth type: None

Test connection + health check, then attach the tools to bAI.

## Demo flow

1. Cook sends a real WhatsApp text/voice note to Twilio Sandbox.
2. Run bAI and ask it to check the latest cook update.
3. bAI calls `get_latest_whatsapp_message`.
4. If it is voice, bAI takes the returned `public_url` and calls your existing
   Gnani STT tool.
5. bAI updates kitchen state and decides the meal.
6. bAI calls `send_whatsapp_message` to reply to the real sender.
7. bAI calls `mark_whatsapp_message_processed`.

This avoids needing an AgenticOrg API key because bAI pulls WhatsApp updates as MCP
tools from inside AgenticOrg.
