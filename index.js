require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = app.listen(PORT, () => {
  console.log(`✅ WebSocket server running on port ${PORT}`);
});

// Health check endpoint (Railway needs this)
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    service: 'Vonage WebSocket Service',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ healthy: true });
});

// WebSocket server for Vonage
const wss = new WebSocketServer({ 
  server,
  path: "/plugins/phone/stream",
  perMessageDeflate: false,  // CRITICAL: No compression for Vonage
  clientNoContextTakeover: true,
  serverNoContextTakeover: true
});

console.log("🎤 WebSocket server registered on /plugins/phone/stream");

wss.on("connection", async (vonageWS, request) => {
  console.log("📞 New Vonage WebSocket connection");
  console.log("📞 Request URL:", request.url);
  
  // Extract parameters from URL
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const businessId = url.searchParams.get('business_id') || url.searchParams.get('assistant_id') || "default";
  const conversationId = url.searchParams.get('conversation_id') || "unknown";
  const fromNumber = url.searchParams.get('from') || "unknown";
  const toNumber = url.searchParams.get('to') || "unknown";
  
  console.log(`🏢 Business: ${businessId}, Conversation: ${conversationId}`);
  console.log(`📞 From: ${fromNumber}, To: ${toNumber}`);
  
  let openaiWS = null;
  let streamId = "";
  let sequence = 0;

  // Helper to send to OpenAI
  const sendOpenAI = (obj) => {
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify(obj));
    }
  };
  
  // Helper to send audio back to Vonage
  const sendVonageAudio = (base64Audio) => {
    if (vonageWS.readyState === WebSocket.OPEN && streamId) {
      sequence++;
      vonageWS.send(JSON.stringify({
        event: "media",
        stream_id: streamId,
        media: { payload: base64Audio },
        sequence
      }));
    }
  };

  // Connect to OpenAI
  const createOpenAIConnection = async () => {
    const model = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-10-01";
    const instructions = getBusinessInstructions(businessId);
    
    console.log(`🤖 Creating OpenAI connection for business: ${businessId}`);
    
    openaiWS = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });

    openaiWS.on("open", () => {
      console.log("🤖 OpenAI Realtime session connected");
      sendOpenAI({
        type: "session.update",
        session: {
          instructions: instructions,
          voice: process.env.VOICE_NAME || "alloy",
          modalities: ["text", "audio"],
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: {
            type: "server_vad",
            threshold: Number(process.env.VAD_THRESHOLD || 0.5),
            prefix_padding_ms: Number(process.env.VAD_PREFIX_MS || 200),
            silence_duration_ms: Number(process.env.VAD_SILENCE_MS || 300)
          }
        }
      });
      // Greet the caller
      sendOpenAI({ type: "response.create" });
    });

    openaiWS.on("message", (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        if (evt.type === "response.audio.delta" && evt.delta) {
          // Forward OpenAI audio to Vonage
          sendVonageAudio(evt.delta);
        }
      } catch (error) {
        console.error("❌ OpenAI message error:", error);
      }
    });

    openaiWS.on("error", (error) => {
      console.error("❌ OpenAI WebSocket error:", error);
    });

    openaiWS.on("close", () => {
      console.log("🤖 OpenAI Realtime session closed");
    });
  };

      // Handle Vonage messages
  vonageWS.on("message", async (raw) => {
    try {
      // Vonage sends text messages (JSON) for control, might send binary for audio
      // First, check if it's actually parseable JSON
      const rawString = raw.toString();
      
      // Skip if it looks like binary data (starts with non-JSON characters)
      if (rawString[0] !== '{' && rawString[0] !== '[') {
        // This is likely binary audio data, not a JSON message
        // Vonage should send audio in JSON format, so this shouldn't happen
        // But if it does, just skip it
        return;
      }
      
      const msg = JSON.parse(rawString);
 
      if (msg.event === "connected") {
        console.log("📞 Vonage connected, version:", msg.version);
      } else if (msg.event === "start") {
        streamId = msg.stream_id;
        console.log("🎬 Call started, stream_id:", streamId);
        await createOpenAIConnection();
      } else if (msg.event === "media" && msg.media?.payload) {
        // Forward Vonage audio to OpenAI
        sendOpenAI({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        });
      } else if (msg.event === "stop") {
        console.log("🛑 Call ended");
        if (openaiWS) openaiWS.close();
      }
    } catch (error) {
      // Only log actual errors, not parsing issues from non-JSON data
      if (error.message && !error.message.includes('Unexpected token')) {
        console.error("❌ Vonage message error:", error);
      }
    }

  vonageWS.on("error", (error) => {
    console.error("❌ Vonage WebSocket error:", error);
  });

  vonageWS.on("close", () => {
    console.log("📞 Vonage connection closed");
    if (openaiWS) openaiWS.close();
  });
});

// Business instructions lookup
function getBusinessInstructions(bizId) {
  const profiles = {
    wethreeloggerheads: "You are Joggle for We Three Loggerheads pub. Tone: warm, friendly, and welcoming. You can answer about opening hours, food menu, drinks, events, bookings, and general pub information. If caller wants to book a table, collect name, phone, date, time, and number of guests. Always be helpful and represent the pub's friendly atmosphere.",
    abbeygaragedoors: "You are Joggle for Abbey Garage Doors NW. Tone: helpful, practical, local UK. You can answer about opening hours, service areas, new door quotes, repairs, emergency callouts, and booking callbacks. If urgent safety issue, reassure and offer to escalate to a human.",
    default: "You are the business's Joggle phone assistant. Be concise, friendly, and interruptible. If unsure, ask a short clarifying question. Offer to leave a message or transfer to a human if needed."
  };
  return profiles[bizId] || profiles.default;
}

console.log(`🚀 Service started successfully on port ${PORT}`);
