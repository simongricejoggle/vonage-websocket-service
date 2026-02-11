import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const JOGGLE_API = process.env.JOGGLE_API || "https://joggle.ai";
const RELAY_KEY = process.env.PHONE_RELAY_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

if (!RELAY_KEY) {
  console.error("PHONE_RELAY_KEY is required for secure communication with Joggle API");
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Joggle Phone Relay");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "", "ws://localhost");
  const pathname = url.pathname;

  console.log(`[UPGRADE] ${pathname} from ${request.headers.origin || request.headers.host || "unknown"}`);

  if (pathname === "/plugins/phone/stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    console.log(`[UPGRADE] Rejected unknown path: ${pathname}`);
    socket.destroy();
  }
});

async function fetchVoiceConfig(businessId) {
  try {
    const url = `${JOGGLE_API}/api/internal/phone/voice-config/${encodeURIComponent(businessId)}`;
    console.log(`[CONFIG] Fetching: ${url}`);
    const res = await fetch(url, {
      headers: { "x-relay-key": RELAY_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`[CONFIG] Failed for ${businessId}:`, err.message);
    return {
      voice: "ash",
      greeting: "Hello, how can I help you today?",
      instructions: "You are a helpful phone assistant. Be concise and friendly.",
    };
  }
}

function connectOpenAI() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("OpenAI connection timeout"));
    }, 10000);
    ws.once("open", () => { clearTimeout(timeout); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

wss.on("connection", async (vonageWS, request) => {
  const url = new URL(request.url || "", "ws://localhost");
  const businessId = url.searchParams.get("business_id") || "default";
  const conversationId = url.searchParams.get("conversation_id") || "unknown";
  const fromNumber = url.searchParams.get("from") || "unknown";
  const toNumber = url.searchParams.get("to") || "unknown";

  console.log(`[CALL] New connection: business=${businessId} conv=${conversationId} from=${fromNumber} to=${toNumber}`);

  let openaiWS = null;
  let streamId = "";
  let sequence = 0;
  let greetingSent = false;
  let vonageStreamReady = false;
  let openaiReady = false;
  let config = null;
  let cleaned = false;
  const audioBuffer = [];

  const sendOpenAI = (obj) => {
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify(obj));
    }
  };

  const sendVonageAudio = (base64Audio) => {
    if (vonageWS.readyState === WebSocket.OPEN && streamId) {
      sequence++;
      vonageWS.send(JSON.stringify({
        event: "media",
        stream_id: streamId,
        media: { payload: base64Audio },
        sequence,
      }));
    }
  };

  const flushAudioBuffer = () => {
    if (audioBuffer.length > 0) {
      console.log(`[CALL] Flushing ${audioBuffer.length} buffered audio chunks`);
      for (const chunk of audioBuffer) {
        sendOpenAI({ type: "input_audio_buffer.append", audio: chunk });
      }
      audioBuffer.length = 0;
    }
  };

  const trySendGreeting = () => {
    if (greetingSent || !vonageStreamReady || !openaiReady || !config) return;
    console.log(`[CALL] Sending greeting: "${config.greeting}"`);
    sendOpenAI({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: `Please say exactly: "${config.greeting}"`,
      },
    });
    greetingSent = true;
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    console.log(`[CALL] Cleanup: business=${businessId} conv=${conversationId}`);
    try { if (openaiWS) openaiWS.close(); } catch {}
    try { vonageWS.close(); } catch {}
  };

  vonageWS.on("message", (data) => {
    try {
      if (typeof data !== "string" && !Buffer.isBuffer(data)) return;
      const str = data.toString();
      if (!str.startsWith("{")) return;
      const msg = JSON.parse(str);

      if (msg.event === "connected") {
        console.log(`[CALL] Vonage connected, version: ${msg.version}`);
      }

      if (msg.event === "start") {
        streamId = msg.stream_id;
        console.log(`[CALL] Stream started: ${streamId}`);
        if (msg.start?.custom_parameters) {
          console.log(`[CALL] Custom params:`, msg.start.custom_parameters);
        }
        vonageStreamReady = true;
        trySendGreeting();
      }

      if (msg.event === "media" && msg.media?.payload) {
        if (openaiReady && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
          sendOpenAI({ type: "input_audio_buffer.append", audio: msg.media.payload });
        } else {
          audioBuffer.push(msg.media.payload);
          if (audioBuffer.length > 500) audioBuffer.shift();
        }
      }

      if (msg.event === "stop") {
        console.log(`[CALL] Stream stopped`);
        cleanup();
      }
    } catch (e) {
      console.error(`[CALL] Vonage message error:`, e.message);
    }
  });

  vonageWS.on("close", () => { console.log(`[CALL] Vonage closed`); cleanup(); });
  vonageWS.on("error", (e) => { console.error(`[CALL] Vonage error:`, e.message); cleanup(); });

  try {
    config = await fetchVoiceConfig(businessId);
    console.log(`[CALL] Config loaded: voice=${config.voice}`);

    openaiWS = await connectOpenAI();
    console.log(`[CALL] OpenAI connected`);

    sendOpenAI({
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
    });

    openaiReady = true;
    flushAudioBuffer();
    trySendGreeting();

    openaiWS.on("message", (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        if (evt.type === "response.audio.delta" && evt.delta) {
          sendVonageAudio(evt.delta);
        }
        if (evt.type === "error") {
          console.error(`[CALL] OpenAI error event:`, evt.error);
        }
      } catch (e) {
        console.error(`[CALL] OpenAI message parse error:`, e.message);
      }
    });

    openaiWS.on("error", (e) => console.error(`[CALL] OpenAI WS error:`, e.message));
    openaiWS.on("close", () => { console.log(`[CALL] OpenAI closed`); cleanup(); });

  } catch (err) {
    console.error(`[CALL] Setup failed:`, err.message);
    cleanup();
  }
});

server.listen(PORT, () => {
  console.log(`Joggle Phone Relay listening on port ${PORT}`);
  console.log(`JOGGLE_API: ${JOGGLE_API}`);
  console.log(`OpenAI Model: ${OPENAI_MODEL}`);
});
