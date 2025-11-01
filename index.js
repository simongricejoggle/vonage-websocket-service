require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// Resample PCM16 audio from 24kHz to 16kHz
function resample24to16(buffer24k) {
  // Convert buffer to Int16Array
  const samples24k = new Int16Array(buffer24k.buffer, buffer24k.byteOffset, buffer24k.length / 2);
  const ratio = 24000 / 16000; // 1.5
  const outputLength = Math.floor(samples24k.length / ratio);
  const samples16k = new Int16Array(outputLength);
  
  // Simple linear interpolation downsampling
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples24k.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    
    // Linear interpolation
    samples16k[i] = Math.round(
      samples24k[srcIndexFloor] * (1 - fraction) + 
      samples24k[srcIndexCeil] * fraction
    );
  }
  
  return Buffer.from(samples16k.buffer);
}

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
  // Interruption handling state
  let activeResponseId = null;
  let isAiSpeaking = false;
  let audioQueue = [];  // Buffer for queued audio packets

  const sendOpenAI = (obj) => {
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify(obj));
    }
  };
  
  const sendVonageAudio = (base64Audio) => {
    if (vonageWS.readyState === WebSocket.OPEN) {
      // OpenAI sends 24kHz PCM16, Vonage expects 16kHz PCM16
      const audioBuffer24k = Buffer.from(base64Audio, 'base64');
      const audioBuffer16k = resample24to16(audioBuffer24k);
      vonageWS.send(audioBuffer16k);
    }
  };

  const createOpenAIConnection = async () => {
    const model = "gpt-realtime";
    const baseInstructions = getBusinessInstructions(businessId);
    
    // Fetch knowledge base and voice settings from main app
    let knowledge = "";
    let voiceConfig = { voice: "alloy", speed: 1.0 };
    let voiceInstructions = "";
    let languagePrompt = "";
    let welcomeGreeting = "Hi, this is Joggle answering for your business.";
    
    try {
      const knowledgeUrl = `${process.env.REPLIT_APP_URL || 'https://joggle-ai-production.replit.app'}/api/phone/knowledge/${businessId}`;
      console.log(`📚 Fetching knowledge from: ${knowledgeUrl}`);
      
      const response = await fetch(knowledgeUrl);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          knowledge = data.knowledge || "";
          voiceConfig = data.voiceConfig || { voice: "alloy", speed: 1.0 };
          voiceInstructions = data.voiceInstructions || "";
          languagePrompt = data.languagePrompt || "";
          welcomeGreeting = voiceConfig.welcomeGreeting || welcomeGreeting;
          console.log(`✅ Retrieved ${knowledge.length} chars of knowledge`);
          console.log(`🎙️ Voice config:`, voiceConfig);
          console.log(`👋 Welcome greeting: ${welcomeGreeting}`);
          if (languagePrompt) {
            console.log(`🌍 Language prompt: ${languagePrompt.substring(0, 100)}...`);
          }
        }
      } else {
        console.log(`⚠️ Knowledge fetch failed: ${response.status}`);
      }
    } catch (error) {
      console.log(`⚠️ Could not fetch knowledge:`, error.message);
    }
    
    // Combine instructions - LANGUAGE FIRST (if non-English), then base, then knowledge, then voice style
    let instructions = "";
    
    // Add language prompt first if non-English (same as webapp)
    if (languagePrompt) {
      instructions = `${languagePrompt}\n\n==========\n\n`;
      console.log(`🌍 Voice session using non-English language`);
    }
    
    // Then base instructions
    instructions += baseInstructions;
    
    // Then knowledge base
    if (knowledge) {
      instructions += `\n\nKNOWLEDGE BASE:\n${knowledge}`;
    }
    
    // Then voice style instructions
    if (voiceInstructions) {
      instructions += voiceInstructions;
    }
    
    // Enforce English by default unless a non-English language is explicitly set
    if (!voiceConfig.language || voiceConfig.language === 'en-GB' || voiceConfig.language === 'en-US') {
      instructions += "\n\nIMPORTANT: Always respond in English only.";
    }
    
    console.log(`🤖 Creating OpenAI connection for business: ${businessId}`);
    
    openaiWS = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });

    openaiWS.on("open", () => {
      console.log("🤖 OpenAI Realtime session connected");
      
      // Build session configuration with voice settings
      const sessionConfig = {
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: instructions,
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                threshold: 0.35,  // More sensitive for faster detection (aligned with webapp)
                prefix_padding_ms: 120,  // Faster start
                silence_duration_ms: 160,  // Faster turn-taking
                create_response: false  // Manual control for better interruption handling
              }
            },
            output: { 
              voice: voiceConfig.voice
            }
          }
        }
      };
      
      // Add speed if configured (and not default)
      if (voiceConfig.speed && voiceConfig.speed !== 1.0) {
        sessionConfig.session.speed = voiceConfig.speed;
        console.log(`⚡ Voice speed set to: ${voiceConfig.speed}x`);
      }
      
      sendOpenAI(sessionConfig);
      openaiReady = true;
      console.log("✅ OpenAI session configured, ready for audio");
      console.log("📝 Full instructions length:", instructions.length);
      
      // Add welcome greeting as user message, then ask AI to respond
      console.log(`👋 Sending welcome prompt: "${welcomeGreeting}"`);
      sendOpenAI({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `[SYSTEM: This is the start of the call. Greet the caller by saying exactly: "${welcomeGreeting}" and then wait for them to respond.]`
            }
          ]
        }
      });
      
      // Trigger the greeting response
      sendOpenAI({ type: "response.create" });
    });

    openaiWS.on("message", (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        
        // Log important events for debugging
        if (evt.type && !evt.type.includes('.delta')) {
          console.log(`🔔 OpenAI event: ${evt.type}`);
        }
        
        // Track response lifecycle for interruption handling
        if (evt.type === "response.created") {
          activeResponseId = evt.response?.id || null;
          console.log(`🎯 Response created: ${activeResponseId}`);
        } else if (evt.type === "response.output_item.added" || 
                   (evt.type === "response.output_audio.delta" && !isAiSpeaking)) {
          // AI has started speaking
          isAiSpeaking = true;
          console.log("🔊 AI started speaking");
        } else if (evt.type === "input_audio_buffer.speech_started") {
          // User started speaking
          if (isAiSpeaking && activeResponseId) {
            // INTERRUPTION DETECTED - Cancel AI response immediately
            console.log(`⚠️ Interruption detected - canceling response ${activeResponseId}`);
            
            // Send cancel message to OpenAI with response ID
            sendOpenAI({ 
              type: "response.cancel",
              response_id: activeResponseId
            });
            
            // Clear audio queue to prevent further playback
            audioQueue = [];
            
            // Clear AI speaking state
            isAiSpeaking = false;
            activeResponseId = null;
            
            console.log("✅ AI response canceled, ready for user input");
          } else {
            console.log("🎤 User started speaking");
          }
        } else if (evt.type === "input_audio_buffer.speech_stopped") {
          console.log("🎤 User stopped speaking");
          // After user finishes speaking, create a new response
          sendOpenAI({ type: "response.create" });
        } else if (evt.type === "response.done") {
          // AI finished responding
          isAiSpeaking = false;
          activeResponseId = null;
          console.log("✅ Response completed");
        }
        
        // GA API uses response.output_audio.delta (not response.audio.delta)
        if (evt.type === "response.output_audio.delta" && evt.delta) {
          // Only forward audio if AI is still speaking (not interrupted)
          if (isAiSpeaking) {
            sendVonageAudio(evt.delta);
          }
        } else if (evt.type === "error") {
          // Ignore expected cancellation errors
          if (evt.error.message?.includes('no active response') || 
              evt.error.message?.includes('cancelled')) {
            console.log("ℹ️ Response cancellation confirmed");
          } else {
            console.error("❌ OpenAI error:", JSON.stringify(evt.error, null, 2));
          }
        } else if (evt.type === "session.updated") {
          console.log("✅ Session updated successfully");
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
        } else if (isBuffer && raw.length !== 640) {
          console.log(`⚠️ Unexpected audio buffer size: ${raw.length} bytes (expected 640)`);
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
