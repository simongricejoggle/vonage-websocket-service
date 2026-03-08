const { createServer } = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8080;
const JOGGLE_API = process.env.JOGGLE_API || "https://joggle.it";
const RELAY_KEY = process.env.PHONE_RELAY_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const PREWARM_TTL = 30000;

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

if (!RELAY_KEY) {
  console.error("PHONE_RELAY_KEY is required");
  process.exit(1);
}

// ── Audio Resampling ──
// Vonage sends/expects pcm16 at 16kHz
// OpenAI Realtime API requires pcm16 at 24kHz
// We must resample in both directions

function resample16kTo24k(base64Audio) {
  const inputBuf = Buffer.from(base64Audio, "base64");
  const sampleCount = Math.floor(inputBuf.length / 2);
  const outputCount = Math.floor(sampleCount * 1.5);
  const output = Buffer.alloc(outputCount * 2);

  for (let i = 0; i < outputCount; i++) {
    const srcPos = (i * 2) / 3;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = srcIdx < sampleCount ? inputBuf.readInt16LE(srcIdx * 2) : 0;
    const s1 = srcIdx + 1 < sampleCount ? inputBuf.readInt16LE((srcIdx + 1) * 2) : s0;
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return output.toString("base64");
}

function resample24kTo16k(base64Audio) {
  const inputBuf = Buffer.from(base64Audio, "base64");
  const sampleCount = Math.floor(inputBuf.length / 2);
  const outputCount = Math.floor(sampleCount * (2 / 3));
  const output = Buffer.alloc(outputCount * 2);

  for (let i = 0; i < outputCount; i++) {
    const srcPos = (i * 3) / 2;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = srcIdx < sampleCount ? inputBuf.readInt16LE(srcIdx * 2) : 0;
    const s1 = srcIdx + 1 < sampleCount ? inputBuf.readInt16LE((srcIdx + 1) * 2) : s0;
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return output.toString("base64");
}

// ── Pre-warmed Sessions ──
const prewarmedSessions = new Map();

// ── HTTP Server ──
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime(), prewarmed: prewarmedSessions.size }));
    return;
  }

  if (req.method === "POST" && req.url === "/prewarm") {
    const relayKey = req.headers["x-relay-key"];
    if (relayKey !== RELAY_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const { assistantId, conversationId } = data;
        if (!assistantId || !conversationId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "assistantId and conversationId required" }));
          return;
        }

        console.log("[PREWARM] Starting for assistant=" + assistantId + " conv=" + conversationId);

        const session = {
          businessId: String(assistantId),
          conversationId: conversationId,
          config: null,
          openaiWS: null,
          ready: false,
          createdAt: Date.now(),
        };
        prewarmedSessions.set(conversationId, session);

        prewarmSession(session).catch((err) => {
          console.error("[PREWARM] Failed for " + conversationId + ":", err.message);
          prewarmedSessions.delete(conversationId);
        });

        setTimeout(() => {
          const s = prewarmedSessions.get(conversationId);
          if (s) {
            console.log("[PREWARM] TTL expired for " + conversationId);
            if (s.openaiWS) { try { s.openaiWS.close(); } catch (e) {} }
            prewarmedSessions.delete(conversationId);
          }
        }, PREWARM_TTL);

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "prewarming", conversationId: conversationId }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Joggle Phone Relay");
});

// ── WebSocket Server ──
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "", "ws://localhost");
  const pathname = url.pathname;

  console.log("[UPGRADE] " + pathname);

  if (pathname === "/plugins/phone/stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    console.log("[UPGRADE] Rejected: " + pathname);
    socket.destroy();
  }
});

// ── Helper Functions ──

async function fetchVoiceConfig(assistantId) {
  try {
    const url = JOGGLE_API + "/api/internal/phone/voice-config/" + encodeURIComponent(assistantId);
    console.log("[CONFIG] Fetching: " + url);
    const res = await fetch(url, {
      headers: { "x-relay-key": RELAY_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    console.error("[CONFIG] Failed for " + assistantId + ":", err.message);
    return {
      voice: "ash",
      greeting: "Hello, how can I help you today?",
      instructions: "You are a helpful phone assistant. Be concise and friendly.",
    };
  }
}

function connectOpenAI() {
  return new Promise((resolve, reject) => {
    const url = "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(OPENAI_MODEL);
    const ws = new WebSocket(url, {
      headers: { Authorization: "Bearer " + OPENAI_API_KEY, "OpenAI-Beta": "realtime=v1" },
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("OpenAI connection timeout"));
    }, 10000);
    ws.once("open", () => { clearTimeout(timeout); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

function configureOpenAISession(openaiWS, config) {
  const msg = {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: config.instructions,
      voice: config.voice,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    },
  };
  openaiWS.send(JSON.stringify(msg));
}

async function prewarmSession(session) {
  const t0 = Date.now();

  session.config = await fetchVoiceConfig(session.businessId);
  console.log("[PREWARM] Config in " + (Date.now() - t0) + "ms");

  session.openaiWS = await connectOpenAI();
  console.log("[PREWARM] OpenAI in " + (Date.now() - t0) + "ms");

  configureOpenAISession(session.openaiWS, session.config);

  session.ready = true;
  console.log("[PREWARM] Ready in " + (Date.now() - t0) + "ms for " + session.conversationId);
}

// ── Call Handler ──

wss.on("connection", async (vonageWS, request) => {
  const url = new URL(request.url || "", "ws://localhost");
  const businessId = url.searchParams.get("assistant_id") || url.searchParams.get("business_id") || "default";
  const conversationId = url.searchParams.get("conversation_id") || "unknown";
  const fromNumber = url.searchParams.get("from") || "unknown";
  const toNumber = url.searchParams.get("to") || "unknown";

  console.log("[CALL] New: biz=" + businessId + " conv=" + conversationId + " from=" + fromNumber);

  let openaiWS = null;
  let greetingSent = false;
  let vonageStreamReady = false;
  let openaiReady = false;
  let config = null;
  let cleaned = false;
  let audioPacketsSent = 0;
  let audioPacketsReceived = 0;
  const audioBuffer = [];

  // Check for pre-warmed session
  const prewarmed = prewarmedSessions.get(conversationId);
  if (prewarmed && prewarmed.ready && prewarmed.openaiWS && prewarmed.openaiWS.readyState === WebSocket.OPEN) {
    console.log("[CALL] Using pre-warmed session");
    openaiWS = prewarmed.openaiWS;
    config = prewarmed.config;
    openaiReady = true;
    prewarmedSessions.delete(conversationId);
  } else {
    if (prewarmed) {
      console.log("[CALL] Pre-warmed not ready, will cold start");
      if (prewarmed.openaiWS) { try { prewarmed.openaiWS.close(); } catch (e) {} }
      prewarmedSessions.delete(conversationId);
    } else {
      console.log("[CALL] No pre-warmed session, cold start");
    }
  }

  const sendOpenAI = (obj) => {
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify(obj));
    }
  };

  const sendVonageAudio = (base64Audio24k) => {
    if (vonageWS.readyState !== WebSocket.OPEN || !vonageStreamReady) return;

    try {
      const audio16kBase64 = resample24kTo16k(base64Audio24k);
      const audio16kBuf = Buffer.from(audio16kBase64, "base64");
      vonageWS.send(audio16kBuf);
      audioPacketsSent++;
      if (audioPacketsSent === 1) {
        console.log("[CALL] First audio packet sent to caller");
      }
    } catch (e) {
      console.error("[CALL] Audio send error:", e.message);
    }
  };

  const flushAudioBuffer = () => {
    if (audioBuffer.length > 0) {
      console.log("[CALL] Flushing " + audioBuffer.length + " buffered audio chunks");
      for (const chunk of audioBuffer) {
        const audio24k = resample16kTo24k(chunk);
        sendOpenAI({ type: "input_audio_buffer.append", audio: audio24k });
      }
      audioBuffer.length = 0;
    }
  };

  const trySendGreeting = () => {
    if (greetingSent || !vonageStreamReady || !openaiReady || !config) return;
    console.log("[CALL] Sending greeting: \"" + config.greeting + "\"");
    sendOpenAI({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Please say exactly: \"" + config.greeting + "\"",
      },
    });
    greetingSent = true;
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    console.log("[CALL] Cleanup: biz=" + businessId + " sent=" + audioPacketsSent + " recv=" + audioPacketsReceived);
    try { if (openaiWS) openaiWS.close(); } catch (e) {}
    try { vonageWS.close(); } catch (e) {}
  };

  // Handle Vonage messages
  // Vonage sends JSON control events as text frames, raw binary PCM16 as binary frames
  vonageWS.on("message", (data) => {
    try {
      const isBuffer = Buffer.isBuffer(data);

      if (!isBuffer) {
        // JSON control message
        const str = data.toString();
        if (!str.startsWith("{")) return;
        const msg = JSON.parse(str);

        if (msg.event === "websocket:connected") {
          console.log("[CALL] Vonage websocket:connected");
          vonageStreamReady = true;
          trySendGreeting();
        } else if (msg.event === "websocket:cleared" || msg.event === "websocket:notify") {
          // Acknowledgement events — no action needed
        } else {
          console.log("[CALL] Vonage event: " + msg.event);
        }
      } else {
        // Raw binary PCM16 audio at 16kHz from Vonage
        if (!vonageStreamReady) {
          console.log("[CALL] Audio received before websocket:connected — setting stream ready");
          vonageStreamReady = true;
          trySendGreeting();
        }
        audioPacketsReceived++;
        if (audioPacketsReceived === 1) {
          console.log("[CALL] First audio from caller received (" + data.length + " bytes)");
        }

        const base64_16k = data.toString("base64");
        if (openaiReady && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
          const audio24k = resample16kTo24k(base64_16k);
          sendOpenAI({ type: "input_audio_buffer.append", audio: audio24k });
        } else {
          audioBuffer.push(base64_16k);
          if (audioBuffer.length > 500) audioBuffer.shift();
        }
      }
    } catch (e) {
      console.error("[CALL] Vonage msg error:", e.message);
    }
  });

  vonageWS.on("close", () => { console.log("[CALL] Vonage closed"); cleanup(); });
  vonageWS.on("error", (e) => { console.error("[CALL] Vonage error:", e.message); cleanup(); });

  // Setup OpenAI handlers
  const attachOpenAIHandlers = () => {
    openaiWS.on("message", (raw) => {
      try {
        const evt = JSON.parse(raw.toString());

        if (evt.type === "response.audio.delta" && evt.delta) {
          sendVonageAudio(evt.delta);
        }

        if (evt.type === "session.created") {
          console.log("[CALL] OpenAI session created");
        }

        if (evt.type === "session.updated") {
          console.log("[CALL] OpenAI session configured");
        }

        if (evt.type === "input_audio_buffer.speech_started") {
          console.log("[CALL] Caller speaking detected");
        }

        if (evt.type === "input_audio_buffer.speech_stopped") {
          console.log("[CALL] Caller stopped speaking");
        }

        if (evt.type === "response.audio_transcript.done" && evt.transcript) {
          console.log("[CALL] AI said: " + evt.transcript.substring(0, 100));
        }

        if (evt.type === "conversation.item.input_audio_transcription.completed" && evt.transcript) {
          console.log("[CALL] Caller said: " + evt.transcript.substring(0, 100));
        }

        if (evt.type === "error") {
          console.error("[CALL] OpenAI error:", JSON.stringify(evt.error));
        }
      } catch (e) {
        console.error("[CALL] OpenAI msg parse error:", e.message);
      }
    });

    openaiWS.on("error", (e) => { console.error("[CALL] OpenAI error:", e.message); });
    openaiWS.on("close", () => { console.log("[CALL] OpenAI closed"); cleanup(); });
  };

  if (openaiReady) {
    attachOpenAIHandlers();
    flushAudioBuffer();
    trySendGreeting();
  } else {
    try {
      config = await fetchVoiceConfig(businessId);
      console.log("[CALL] Config loaded: voice=" + config.voice);

      openaiWS = await connectOpenAI();
      console.log("[CALL] OpenAI connected");

      configureOpenAISession(openaiWS, config);

      openaiReady = true;
      attachOpenAIHandlers();
      flushAudioBuffer();
      trySendGreeting();
    } catch (err) {
      console.error("[CALL] Setup failed:", err.message);
      cleanup();
    }
  }
});

server.listen(PORT, () => {
  console.log("Joggle Phone Relay v2.0 listening on port " + PORT);
  console.log("JOGGLE_API: " + JOGGLE_API);
  console.log("Model: " + OPENAI_MODEL);
  console.log("Audio: Vonage 16kHz <-> OpenAI 24kHz resampling enabled");
});
