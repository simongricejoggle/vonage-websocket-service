require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, () => {
  console.log(`✅ WebSocket server running on port ${PORT}`);
});

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

const wss = new WebSocketServer({ 
  server,
  path: "/plugins/phone/stream",
  perMessageDeflate: false,
  clientNoContextTakeover: true,
  serverNoContextTakeover: true
});

console.log("🎤 WebSocket server registered on /plugins/phone/stream");

wss.on("connection", async (vonageWS, request) => {
  console.log("📞 New Vonage WebSocket connection");
  console.log("📞 Request URL:", request.url);
  
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const businessId = url.searchParams.get('business_id') || url.searchParams.get('assistant_id') || "default";
  const conversationId = url.searchParams.get('conversation_id') || "unknown";
  const fromNumber = url.searchParams.get('from') || "unknown";
  const toNumber = url.searchParams.get('to') || "unknown";
  
  console.log(`🏢 Business: ${businessId}, Conversation: ${conversationId}`);
  console.log(`📞 From: ${fromNumber}, To: ${toNumber}`);
  
  let openaiWS = null;
  let openaiReady = false;

  const sendOpenAI = (obj) => {
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify(obj));
    }
  };
  
  const sendVonageAudio = (base64Audio) => {
    if (vonageWS.readyState === WebSocket.OPEN) {
      // Vonage expects RAW PCM audio, not JSON-wrapped
      const audioBuffer = Buffer.from(base64Audio, 'base64');
      vonageWS.send(audioBuffer);
    }
  };

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
          type: "realtime",
          instructions: instructions,
          audio: {
            input: { format: "pcm16" },
            output: { 
              format: "pcm16",
              voice: process.env.VOICE_NAME || "alloy"
            }
          },
        }
      });
      openaiReady = true;
      console.log("✅ OpenAI session configured, ready for audio");
      // Greet the caller
      sendOpenAI({ type: "response.create" });
    });

    openaiWS.on("message", (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        // GA API uses response.output_audio.delta (not response.audio.delta)
        if (evt.type === "response.output_audio.delta" && evt.delta) {
          // Forward OpenAI audio to Vonage
          sendVonageAudio(evt.delta);
        } else if (evt.type === "error") {
          console.error("❌ OpenAI error:", evt.error);
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
      openaiReady = false;
    });
  };

  vonageWS.on("message", async (raw) => {
    try {
      // Vonage sends BOTH JSON control messages AND raw binary audio
      const isBuffer = Buffer.isBuffer(raw);
      
      // Try to parse as JSON first
      const rawString = raw.toString();
      
      // If it starts with {, it's a JSON control message
      if (rawString[0] === '{') {
        const msg = JSON.parse(rawString);
        console.log(`📋 Vonage event: ${msg.event}`);
        
        if (msg.event === "websocket:connected") {
          console.log("📞 Vonage connected, content-type:", msg['content-type']);
          // Start OpenAI connection immediately
          await createOpenAIConnection();
        }
      } else {
        // This is binary audio data (640 bytes of L16 PCM)
        if (openaiReady && isBuffer && raw.length === 640) {
          // Convert raw PCM buffer to base64 for OpenAI
          const base64Audio = raw.toString('base64');
          sendOpenAI({
            type: "input_audio_buffer.append",
            audio: base64Audio
          });
        }
      }
    } catch (error) {
      // Only log actual errors, not parsing issues
      if (!error.message?.includes('Unexpected token')) {
        console.error("❌ Vonage message error:", error);
      }
    }
  });

  vonageWS.on("error", (error) => {
    console.error("❌ Vonage WebSocket error:", error);
  });

  vonageWS.on("close", () => {
    console.log("📞 Vonage connection closed");
    if (openaiWS) openaiWS.close();
  });
});

function getBusinessInstructions(bizId) {
  const profiles = {
    wethreeloggerheads: "You are Joggle for We Three Loggerheads pub. Tone: warm, friendly, and welcoming. You can answer about opening hours, food menu, drinks, events, bookings, and general pub information. If caller wants to book a table, collect name, phone, date, time, and number of guests. Always be helpful and represent the pub's friendly atmosphere.",
    abbeygaragedoors: "You are Joggle for Abbey Garage Doors NW. Tone: helpful, practical, local UK. You can answer about opening hours, service areas, new door quotes, repairs, emergency callouts, and booking callbacks. If urgent safety issue, reassure and offer to escalate to a human.",
    default: "You are the business's Joggle phone assistant. Be concise, friendly, and interruptible. If unsure, ask a short clarifying question. Offer to leave a message or transfer to a human if needed."
  };
  return profiles[bizId] || profiles.default;
}

console.log(`🚀 Service started successfully on port ${PORT}`);
