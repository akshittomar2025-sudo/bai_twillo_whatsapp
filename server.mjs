import express from "express";
import twilio from "twilio";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
  console.error("Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_WHATSAPP_FROM");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const app = express();

app.use("/webhook/whatsapp", express.urlencoded({ extended: false }));
app.use("/mcp", express.json({ limit: "2mb" }));

const messages = [];
const MAX_MESSAGES = 100;

function normalizeWhatsAppNumber(value) {
  if (!value) return value;
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

function publicMediaUrl(messageSid, index) {
  if (!PUBLIC_BASE_URL) return null;
  return `${PUBLIC_BASE_URL}/media/${encodeURIComponent(messageSid)}/${index}`;
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "bAI Twilio WhatsApp MCP",
    twilio_webhook: "/webhook/whatsapp",
    mcp_endpoint: "/mcp",
    health: "/health"
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, stored_messages: messages.length }));

// Twilio sends inbound WhatsApp messages here.
app.post("/webhook/whatsapp", (req, res) => {
  const sid = req.body.MessageSid || req.body.SmsMessageSid || `local-${Date.now()}`;
  const numMedia = Number(req.body.NumMedia || 0);

  const media = [];
  for (let i = 0; i < numMedia; i++) {
    media.push({
      index: i,
      source_url: req.body[`MediaUrl${i}`] || null,
      content_type: req.body[`MediaContentType${i}`] || null,
      public_url: publicMediaUrl(sid, i)
    });
  }

  const item = {
    sid,
    from: req.body.From || "",
    to: req.body.To || "",
    body: req.body.Body || "",
    profile_name: req.body.ProfileName || "",
    wa_id: req.body.WaId || "",
    num_media: numMedia,
    media,
    received_at: new Date().toISOString(),
    processed: false
  };

  messages.push(item);
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);

  console.log("Inbound WhatsApp:", JSON.stringify({
    sid: item.sid,
    from: item.from,
    body: item.body,
    num_media: item.num_media
  }));

  // Empty TwiML: do not auto-reply. bAI will decide if/what to send.
  res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

// Public media proxy so Gnani can fetch a Twilio voice note URL.
// Demo-only: do not expose sensitive media this way in production.
app.get("/media/:sid/:index", async (req, res) => {
  try {
    const msg = messages.find(m => m.sid === req.params.sid);
    if (!msg) return res.status(404).send("Message not found");

    const idx = Number(req.params.index);
    const media = msg.media[idx];
    if (!media?.source_url) return res.status(404).send("Media not found");

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const r = await fetch(media.source_url, {
      headers: { Authorization: `Basic ${auth}` },
      redirect: "follow"
    });

    if (!r.ok) return res.status(r.status).send(`Twilio media fetch failed: ${r.status}`);

    const contentType = r.headers.get("content-type") || media.content_type || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    const arrayBuffer = await r.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error("Media proxy error:", err);
    res.status(500).send("Media proxy error");
  }
});

function buildMcpServer() {
  const server = new McpServer({
    name: "bai-twilio-whatsapp",
    version: "1.0.0"
  });

  server.registerTool(
    "get_latest_whatsapp_message",
    {
      description:
        "Get the latest real WhatsApp message received by the Twilio sandbox. " +
        "Returns text plus any media/voice-note URLs. Use public_url for Gnani transcription.",
      inputSchema: {
        only_unprocessed: z.boolean().optional().default(true)
      }
    },
    async ({ only_unprocessed = true }) => {
      const pool = only_unprocessed ? messages.filter(m => !m.processed) : messages;
      const latest = pool.length ? pool[pool.length - 1] : null;

      return {
        content: [{
          type: "text",
          text: latest
            ? JSON.stringify(latest, null, 2)
            : JSON.stringify({ found: false, message: "No matching WhatsApp message available." })
        }]
      };
    }
  );

  server.registerTool(
    "list_recent_whatsapp_messages",
    {
      description: "List recent real WhatsApp messages received by the Twilio sandbox.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().default(5),
        only_unprocessed: z.boolean().optional().default(false)
      }
    },
    async ({ limit = 5, only_unprocessed = false }) => {
      let pool = only_unprocessed ? messages.filter(m => !m.processed) : messages;
      pool = pool.slice(-limit);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(pool, null, 2)
        }]
      };
    }
  );

  server.registerTool(
    "mark_whatsapp_message_processed",
    {
      description:
        "Mark a WhatsApp message as processed after bAI has acted on it, so it is not handled twice.",
      inputSchema: {
        message_sid: z.string().min(1)
      }
    },
    async ({ message_sid }) => {
      const msg = messages.find(m => m.sid === message_sid);
      if (!msg) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Message not found" }) }]
        };
      }
      msg.processed = true;
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, message_sid }) }]
      };
    }
  );

  server.registerTool(
    "send_whatsapp_message",
    {
      description:
        "Send a real WhatsApp text message through the Twilio WhatsApp Sandbox. " +
        "Use the sender number from an inbound message as 'to' when replying.",
      inputSchema: {
        to: z.string().min(5).describe("Recipient phone, e.g. whatsapp:+9198... or +9198..."),
        text: z.string().min(1).max(1500)
      }
    },
    async ({ to, text }) => {
      try {
        const result = await twilioClient.messages.create({
          from: normalizeWhatsAppNumber(TWILIO_WHATSAPP_FROM),
          to: normalizeWhatsAppNumber(to),
          body: text
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              sid: result.sid,
              status: result.status,
              to: result.to,
              from: result.from
            }, null, 2)
          }]
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: err?.message || String(err),
              code: err?.code || null
            }, null, 2)
          }]
        };
      }
    }
  );

  return server;
}

const sessions = new Map();

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "MCP session not found" },
          id: null
        });
      }
      session.lastActive = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Expected MCP initialize request" },
        id: null
      });
    }

    const mcpServer = buildMcpServer();
    let transport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, mcpServer, lastActive: Date.now() });
      }
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: err?.message || String(err) },
        id: null
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) return res.status(400).send("Missing or invalid MCP session ID");
  session.lastActive = Date.now();
  await session.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) return res.status(404).send("MCP session not found");
  await session.transport.handleRequest(req, res);
  sessions.delete(sessionId);
});

setInterval(async () => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of sessions.entries()) {
    if (session.lastActive < cutoff) {
      try { await session.transport.close(); } catch {}
      sessions.delete(id);
    }
  }
}, 60_000).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`bAI Twilio WhatsApp MCP listening on ${PORT}`);
  console.log(`Webhook: /webhook/whatsapp`);
  console.log(`MCP: /mcp`);
});
