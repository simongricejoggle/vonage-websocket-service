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
          // Greeting pre-generation
          greetingAudioBuffer: [],
          greetingBufferReady: false,
          greetingResponseId: null,
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
  const baseVoice = (config.voice || "ash").split("+")[0];
  const msg = {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: config.instructions,
      voice: baseVoice,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: null,
    },
  };
  openaiWS.send(JSON.stringify(msg));
}

function enableVAD(openaiWS) {
  openaiWS.send(JSON.stringify({
    type: "session.update",
    session: {
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    },
  }));
}

// ── Greeting Pre-generation ──
// Called after configureOpenAISession during prewarm.
// Waits for session.updated, then triggers the greeting and buffers audio deltas.
// By the time Vonage connects (~1-3s later), audio is ready to flush immediately.
function prewarmGreeting(session) {
  const openaiWS = session.openaiWS;

  const onMessage = (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      // Once session is configured, trigger the greeting
      if (evt.type === "session.updated" && !session.greetingResponseId) {
        console.log("[PREWARM] Session configured — triggering greeting pre-generation");
        openaiWS.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: "Please say exactly: \"" + session.config.greeting + "\"",
          },
        }));
      }

      // Track the greeting response ID
      if (evt.type === "response.created" && !session.greetingResponseId) {
        session.greetingResponseId = evt.response && evt.response.id;
        console.log("[PREWARM] Greeting response ID: " + session.greetingResponseId);
      }

      // Buffer audio deltas — these are 24kHz base64 PCM16, same format sendVonageAudio expects
      if (evt.type === "response.audio.delta" && evt.delta) {
        session.greetingAudioBuffer.push(evt.delta);
        if (session.greetingAudioBuffer.length === 1) {
          console.log("[PREWARM] First greeting audio chunk buffered");
        }
      }

      // Greeting generation complete
      if (evt.type === "response.done") {
        const responseId = evt.response && evt.response.id;
        if (responseId === session.greetingResponseId) {
          session.greetingBufferReady = true;
          console.log("[PREWARM] Greeting ready — " + session.greetingAudioBuffer.length + " chunks pre-buffered");
          openaiWS.removeListener("message", onMessage);
        }
      }

      if (evt.type === "error") {
        console.error("[PREWARM] OpenAI error during greeting pre-gen:", JSON.stringify(evt.error));
        openaiWS.removeListener("message", onMessage);
      }
    } catch (e) {}
  };

  openaiWS.on("message", onMessage);
}

async function prewarmSession(session) {
  const t0 = Date.now();

  const [config, openaiWS] = await Promise.all([
    fetchVoiceConfig(session.businessId),
    connectOpenAI(),
  ]);
  console.log("[PREWARM] Config+OpenAI in " + (Date.now() - t0) + "ms");

  session.config = config;
  session.openaiWS = openaiWS;
  configureOpenAISession(session.openaiWS, session.config);

  // Start greeting pre-generation in background — audio will be buffered by the time call arrives
  prewarmGreeting(session);

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
  let greetingDone = false;
  let greetingResponseId = null;
  let greetingAudioReceived = false;
  let vonageStreamReady = false;
  let openaiReady = false;
  let config = null;
  let cleaned = false;
  let audioPacketsSent = 0;
  let audioPacketsReceived = 0;
  const audioBuffer = [];
  const callerAudioDuringGreeting = [];
  let greetingTimeoutId = null;
  let silenceIntervalId = null;

  // 20ms of silence at 16kHz PCM16 = 640 bytes of zeros (standard Vonage frame)
  const SILENCE_FRAME = Buffer.alloc(640, 0);

  const startSilenceKeepAlive = () => {
    if (silenceIntervalId) return;
    console.log("[CALL] Starting silence keep-alive to hold Vonage connection open");
    // Send one silence frame immediately — don't wait for first interval tick
    if (vonageWS.readyState === WebSocket.OPEN) {
      try { vonageWS.send(SILENCE_FRAME); } catch (e) {}
    }
    // Then continue at 50 packets/sec (20ms interval)
    silenceIntervalId = setInterval(() => {
      if (vonageWS.readyState === WebSocket.OPEN && vonageStreamReady) {
        try { vonageWS.send(SILENCE_FRAME); } catch (e) { stopSilenceKeepAlive(); }
      } else {
        stopSilenceKeepAlive();
      }
    }, 20);
  };

  const stopSilenceKeepAlive = () => {
    if (silenceIntervalId) {
      clearInterval(silenceIntervalId);
      silenceIntervalId = null;
      console.log("[CALL] Silence keep-alive stopped");
    }
  };

  // Check for pre-warmed session — save reference so websocket:connected can use it
  let acquiredPrewarm = null;
  const prewarmed = prewarmedSessions.get(conversationId);
  if (prewarmed && prewarmed.ready && prewarmed.openaiWS && prewarmed.openaiWS.readyState === WebSocket.OPEN) {
    console.log("[CALL] Using pre-warmed session");
    openaiWS = prewarmed.openaiWS;
    config = prewarmed.config;
    openaiReady = true;
    acquiredPrewarm = prewarmed;
    prewarmedSessions.delete(conversationId);
  } else if (prewarmed) {
    console.log("[CALL] Pre-warm in progress - will wait after handlers registered");
    // Leave in map — handled after Vonage handlers are set up so silence keep-alive runs
  } else {
    console.log("[CALL] No pre-warmed session, cold start");
  }

  const sendOpenAI = (obj) => {
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify(obj));
    }
  };

  const sendVonageAudio = (base64Audio24k) => {
    if (vonageWS.readyState !== WebSocket.OPEN) {
      if (audioPacketsSent === 0) console.log("[CALL] sendVonageAudio skipped: WS state=" + vonageWS.readyState);
      return;
    }
    if (!vonageStreamReady) {
      if (audioPacketsSent === 0) console.log("[CALL] sendVonageAudio skipped: stream not ready");
      return;
    }

    try {
      if (audioPacketsSent === 0) {
        stopSilenceKeepAlive();
      }
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

  const flushCallerAudioBuffer = () => {
    if (callerAudioDuringGreeting.length > 0) {
      console.log("[CALL] Flushing " + callerAudioDuringGreeting.length + " buffered caller audio chunks after greeting");
      for (const chunk of callerAudioDuringGreeting) {
        const audio24k = resample16kTo24k(chunk);
        sendOpenAI({ type: "input_audio_buffer.append", audio: audio24k });
      }
      callerAudioDuringGreeting.length = 0;
    }
  };

  const sendGreetingRequest = () => {
    sendOpenAI({ type: "input_audio_buffer.clear" });
    sendOpenAI({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: "Please say exactly: \"" + config.greeting + "\"",
      },
    });
  };

  const trySendGreeting = () => {
    if (greetingSent || !vonageStreamReady || !openaiReady || !config) return;
    console.log("[CALL] Sending greeting: \"" + config.greeting + "\"");
    startSilenceKeepAlive();
    sendGreetingRequest();
    greetingSent = true;

    greetingTimeoutId = setTimeout(() => {
      if (!greetingAudioReceived && !greetingDone && !cleaned) {
        console.log("[CALL] Greeting timeout — no audio received from OpenAI, retrying greeting");
        greetingResponseId = null;
        sendGreetingRequest();
      }
    }, 5000);
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (greetingTimeoutId) clearTimeout(greetingTimeoutId);
    stopSilenceKeepAlive();
    console.log("[CALL] Cleanup: biz=" + businessId + " sent=" + audioPacketsSent + " recv=" + audioPacketsReceived);
    try { if (openaiWS) openaiWS.close(); } catch (e) {}
    try { vonageWS.close(); } catch (e) {}
  };

  // Handle Vonage messages
  // Vonage sends JSON control events as text frames, raw binary PCM16 as binary frames
  vonageWS.on("message", (data) => {
    try {
      const isBuffer = Buffer.isBuffer(data);

      // Vonage sometimes sends JSON control events as binary frames — check both
      const possibleJson = isBuffer ? data.toString("utf8") : data.toString();
      const looksLikeJson = possibleJson.charCodeAt(0) === 123; // '{'
      let handledAsJson = false;

      if (looksLikeJson) {
        let msg;
        try { msg = JSON.parse(possibleJson); } catch (e) { msg = null; }

        if (msg && msg.event) {
          handledAsJson = true;
          if (msg.event === "websocket:connected") {
            console.log("[CALL] Vonage websocket:connected (content-type: " + (msg["content-type"] || "unknown") + ")");
            vonageStreamReady = true;

            // If session wasn't ready at connection time, try to acquire it now
            if (!openaiReady) {
              const pw = prewarmedSessions.get(conversationId);
              if (pw && pw.ready && pw.openaiWS && pw.openaiWS.readyState === WebSocket.OPEN) {
                openaiWS = pw.openaiWS;
                config = pw.config;
                openaiReady = true;
                acquiredPrewarm = pw;
                prewarmedSessions.delete(conversationId);
                attachOpenAIHandlers();
                flushAudioBuffer();
              }
            }

            // ── Happy path: pre-generated greeting audio is ready ──
            // acquiredPrewarm holds the session object (saved when session was first acquired)
            if (acquiredPrewarm && acquiredPrewarm.greetingAudioBuffer.length > 0) {
              const chunks = acquiredPrewarm.greetingAudioBuffer.length;
              console.log("[CALL] Flushing " + chunks + " pre-generated greeting chunks (ready=" + acquiredPrewarm.greetingBufferReady + ")");
              greetingSent = true;
              greetingAudioReceived = true;
              greetingResponseId = acquiredPrewarm.greetingResponseId;
              for (const delta of acquiredPrewarm.greetingAudioBuffer) {
                sendVonageAudio(delta);
              }
              acquiredPrewarm.greetingAudioBuffer = [];
              console.log("[CALL] Pre-generated greeting flushed — " + audioPacketsSent + " packets sent");

              // If greeting generation was already complete during pre-warm, response.done
              // will never fire on the call handler — mark done and enable VAD now
              if (acquiredPrewarm.greetingBufferReady) {
                greetingDone = true;
                console.log("[CALL] Greeting complete (pre-generated) — enabling VAD");
                enableVAD(openaiWS);
                flushCallerAudioBuffer();
              }
              // If greeting was still streaming when call arrived, response.done will fire
              // normally through attachOpenAIHandlers and complete the flow
            } else {
              // ⚡ Fallback: greeting not buffered yet — use silence keep-alive while OpenAI generates
              startSilenceKeepAlive();
              trySendGreeting();
            }
          } else if (msg.event === "websocket:cleared" || msg.event === "websocket:notify") {
            // Acknowledgement events — no action needed
          } else {
            console.log("[CALL] Vonage event: " + msg.event);
          }
        }
      }

      if (!handledAsJson && isBuffer) {
        // Raw binary PCM16 audio at 16kHz from Vonage
        if (!vonageStreamReady) {
          console.log("[CALL] Audio received before websocket:connected — setting stream ready");
          vonageStreamReady = true;
          startSilenceKeepAlive();
          trySendGreeting();
        }
        audioPacketsReceived++;
        if (audioPacketsReceived === 1) {
          console.log("[CALL] First audio from caller received (" + data.length + " bytes)");
        }

        const base64_16k = data.toString("base64");
        if (openaiReady && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
          if (!greetingDone) {
            callerAudioDuringGreeting.push(base64_16k);
            if (callerAudioDuringGreeting.length > 500) callerAudioDuringGreeting.shift();
          } else {
            const audio24k = resample16kTo24k(base64_16k);
            sendOpenAI({ type: "input_audio_buffer.append", audio: audio24k });
          }
        } else {
          audioBuffer.push(base64_16k);
          if (audioBuffer.length > 500) audioBuffer.shift();
        }
      }
    } catch (e) {
      console.error("[CALL] Vonage msg error:", e.message);
    }
  });

  vonageWS.on("close", (code, reason) => {
    console.log("[CALL] Vonage closed code=" + code + " reason=" + (reason ? reason.toString() : "none"));
    cleanup();
  });
  vonageWS.on("error", (e) => { console.error("[CALL] Vonage error:", e.message); cleanup(); });

  // Setup OpenAI handlers
  const attachOpenAIHandlers = () => {
    openaiWS.on("message", (raw) => {
      try {
        const evt = JSON.parse(raw.toString());

        const ignoredTypes = new Set(["response.audio.delta", "input_audio_buffer.committed", "response.output_item.added", "response.content_part.added", "response.content_part.done", "response.output_item.done", "conversation.item.created"]);
        if (!ignoredTypes.has(evt.type)) {
          console.log("[OPENAI] " + evt.type + (evt.response ? " id=" + (evt.response.id || "") + " status=" + (evt.response.status || "") : "") + (evt.error ? " err=" + JSON.stringify(evt.error) : ""));
        }

        if (evt.type === "response.audio.delta" && evt.delta) {
          if (!greetingAudioReceived) {
            greetingAudioReceived = true;
            if (greetingTimeoutId) { clearTimeout(greetingTimeoutId); greetingTimeoutId = null; }
            console.log("[CALL] First greeting audio delta received from OpenAI");
          }
          sendVonageAudio(evt.delta);
        }

        if (evt.type === "response.created" && !greetingResponseId && greetingSent) {
          greetingResponseId = evt.response && evt.response.id;
          console.log("[CALL] Greeting response ID: " + greetingResponseId);
        }

        if (evt.type === "response.done") {
          const responseId = evt.response && evt.response.id;
          const responseStatus = evt.response && evt.response.status;
          if (!greetingDone && (responseId === greetingResponseId || greetingResponseId === null)) {
            if (responseStatus === "cancelled" || responseStatus === "failed") {
              console.log("[CALL] Greeting response " + responseStatus + " — retrying greeting");
              greetingResponseId = null;
              greetingAudioReceived = false;
              if (greetingTimeoutId) { clearTimeout(greetingTimeoutId); greetingTimeoutId = null; }
              sendGreetingRequest();
            } else {
              greetingDone = true;
              if (greetingTimeoutId) { clearTimeout(greetingTimeoutId); greetingTimeoutId = null; }
              console.log("[CALL] Greeting complete — enabling VAD and flushing caller audio");
              enableVAD(openaiWS);
              flushCallerAudioBuffer();
            }
          }
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
          if (!greetingDone && greetingSent) {
            console.log("[CALL] Greeting failed due to error — enabling VAD anyway");
            greetingDone = true;
            if (greetingTimeoutId) { clearTimeout(greetingTimeoutId); greetingTimeoutId = null; }
            enableVAD(openaiWS);
            flushCallerAudioBuffer();
          }
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
    // Check if there's an in-progress prewarm to wait for
    const inProgressPrewarm = prewarmedSessions.get(conversationId);
    if (inProgressPrewarm && !inProgressPrewarm.ready) {
      console.log("[CALL] Waiting for in-progress prewarm (up to 8s)...");
      const waitStart = Date.now();
      while (!inProgressPrewarm.ready && Date.now() - waitStart < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      prewarmedSessions.delete(conversationId);

      if (inProgressPrewarm.ready && inProgressPrewarm.openaiWS && inProgressPrewarm.openaiWS.readyState === WebSocket.OPEN) {
        console.log("[CALL] Prewarm completed in " + (Date.now() - waitStart) + "ms - using pre-warmed session");
        openaiWS = inProgressPrewarm.openaiWS;
        config = inProgressPrewarm.config;
        openaiReady = true;
        attachOpenAIHandlers();
        flushAudioBuffer();
        trySendGreeting();
        return;
      } else {
        console.log("[CALL] Prewarm timed out after " + (Date.now() - waitStart) + "ms - cold starting");
        if (inProgressPrewarm.openaiWS) { try { inProgressPrewarm.openaiWS.close(); } catch (e) {} }
      }
    }

    try {
      const [coldConfig, coldWS] = await Promise.all([
        fetchVoiceConfig(businessId),
        connectOpenAI(),
      ]);
      config = coldConfig;
      openaiWS = coldWS;
      console.log("[CALL] Config+OpenAI ready (cold start): voice=" + config.voice);

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
  console.log("Joggle Phone Relay v2.1 listening on port " + PORT);
  console.log("JOGGLE_API: " + JOGGLE_API);
  console.log("Model: " + OPENAI_MODEL);
  console.log("Audio: Vonage 16kHz <-> OpenAI 24kHz resampling enabled");
  console.log("Greeting pre-generation: ENABLED");
});
