// Vonage WebSocket Service v1.1 - Parallel OpenAI + Silence Keep-Alive
// Updated: Nov 14, 2025 - Fixed immediate greeting with parallel connection
require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// Resample PCM16 audio from 24kHz to 16kHz
function resample24to16(buffer24k) {
  // Convert buffer to Int16Array (Node.js uses little-endian by default, which is correct for PCM16)
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
  
  // Return as Buffer (preserves little-endian byte order)
  return Buffer.from(samples16k.buffer, samples16k.byteOffset, samples16k.byteLength);
}

const server = app.listen(PORT, '0.0.0.0', () => {
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

// Pre-warm endpoint - called by Replit server when NCCO is generated
app.post('/prewarm', express.json(), async (req, res) => {
  const { conversationId: rawConvId, businessId } = req.body;
  const conversationId = rawConvId?.toLowerCase(); // Normalize to lowercase
  
  if (!conversationId || !businessId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing conversationId or businessId' 
    });
  }
  
  console.log(`🔥 Pre-warm request received for ${conversationId} (${businessId})`);
  
  // Start pre-warming in background (don't wait for it)
  prewarmOpenAIConnection(conversationId, businessId)
    .then(() => {
      console.log(`✅ Pre-warm completed for ${conversationId}`);
    })
    .catch(err => {
      console.error(`❌ Pre-warm failed for ${conversationId}:`, err.message);
    });
  
  // Return immediately
  res.json({ success: true, message: 'Pre-warming started' });
});

app.get('/test-openai', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ 
      success: false, 
      error: 'OPENAI_API_KEY not configured' 
    });
  }

  try {
    const WebSocket = require('ws');
    const testWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-2025-08-28', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      },
      protocol: 'realtime'
    });

    const timeout = setTimeout(() => {
      testWs.close();
      res.status(500).json({ 
        success: false, 
        error: 'Connection timeout' 
      });
    }, 10000);

    testWs.on('open', () => {
      clearTimeout(timeout);
      testWs.close();
      res.json({ 
        success: true, 
        message: 'Successfully connected to OpenAI Realtime API',
        apiKeyConfigured: true
      });
    });

    testWs.on('error', (error) => {
      clearTimeout(timeout);
      res.status(500).json({ 
        success: false, 
        error: error.message,
        apiKeyConfigured: true
      });
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// NOTE: NCCO endpoint removed - it's handled by the main Replit server
// The Replit server calls /prewarm endpoint above to trigger pre-warming

const wss = new WebSocketServer({ 
  server,
  path: "/plugins/phone/stream",
  perMessageDeflate: false,
  clientNoContextTakeover: true,
  serverNoContextTakeover: true
});

console.log("🎤 WebSocket server registered on /plugins/phone/stream");

// ============================================================================
// PREWARMED SESSION CLASS
// ============================================================================
// Manages OpenAI Realtime connection lifecycle with audio buffering
class PrewarmedSession {
  constructor(conversationId, businessId) {
    this.conversationId = conversationId;
    this.businessId = businessId;
    this.ws = null;
    this.ready = false;
    this.attached = false;
    this.audioBuffer = []; // Buffer audio deltas until Vonage attaches
    this.sendToVonage = null; // Callback to send audio to Vonage
    this.greetingResponseId = null;
    this.greetingComplete = false;
    this.isAiSpeaking = false;
    this.firstAudioSent = false;
    this.onFirstAudio = null; // Callback when first audio is sent
    
    // Knowledge/config data
    this.welcomeGreeting = "Hi, this is Joggle answering for your business.";
    this.voiceConfig = { voice: "ash", speed: 1.0 };
    this.knowledge = null;
    this.languagePrompt = null;
    this.voiceInstructions = null;
    this.fullInstructions = null;
    
    console.log(`🎯 Creating PrewarmedSession for ${conversationId}`);
  }

  async initialize() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    // Create OpenAI WebSocket with beta protocol
    this.ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-2025-08-28', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      },
      protocol: 'realtime'
    });

    // Set up event handlers
    this.setupEventHandlers();

    // Wait ONLY for session ready (fast - just WebSocket connection)
    await this.waitForReady();
    console.log(`✅ Session ${this.conversationId} ready (OpenAI connected)`);
    
    // 🚀 CRITICAL: Send greeting IMMEDIATELY with default config
    // This starts buffering audio RIGHT NOW (2-3s before Vonage connects)
    console.log(`🎤 Sending immediate greeting to start buffering...`);
    this.sendGreeting();
    
    // Fetch knowledge in background and update session after greeting
    this.fetchKnowledge().then(() => {
      console.log(`📚 Knowledge loaded for ${this.conversationId} - will apply after greeting`);
      
      // Apply full knowledge AFTER greeting completes (for subsequent responses)
      // Don't interrupt the greeting that's already playing
      if (this.fullInstructions && this.greetingComplete) {
        this.applyFullKnowledge();
      }
    }).catch(err => {
      console.error(`❌ Knowledge fetch failed for ${this.conversationId}:`, err.message);
    });
    
    return this;
  }

  setupEventHandlers() {
    this.ws.on('open', () => {
      console.log(`✅ OpenAI connected for session ${this.conversationId}`);
      
      // Send initial session config - beta partial update
      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: "You are a helpful assistant.",
          voice: "ash",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
            create_response: true
          },
          temperature: 0.8
        }
      };
      this.ws.send(JSON.stringify(sessionConfig));
    });

    this.ws.on('message', (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        
        // Log session.created (first event from OpenAI)
        if (evt.type === 'session.created') {
          console.log(`📝 Session created for ${this.conversationId}`);
        }
        
        // Mark ready when session is updated (AFTER config is acknowledged)
        if (evt.type === 'session.updated') {
          if (!this.ready) {
            this.ready = true;
            console.log(`🎯 Session ready (updated): ${this.conversationId}`);
          }
        }
        
        // Track response lifecycle
        if (evt.type === 'response.created') {
          if (!this.greetingResponseId) {
            this.greetingResponseId = evt.response.id;
            console.log(`🎤 Greeting response: ${this.greetingResponseId}`);
          }
        }
        
        if (evt.type === 'response.output_item.added') {
          this.isAiSpeaking = true;
          console.log(`🔊 AI speaking in session ${this.conversationId}`);
        }
        
        // CRITICAL: Buffer audio deltas until Vonage attaches
        // Beta API uses 'response.audio.delta' (not 'response.output_audio.delta')
        if (evt.type === 'response.audio.delta' && evt.delta) {
          if (this.attached && this.sendToVonage) {
            // Directly forward to Vonage
            this.sendToVonage(evt.delta);
            // Notify on first audio
            if (this.onFirstAudio && !this.firstAudioSent) {
              this.firstAudioSent = true;
              this.onFirstAudio();
              console.log(`🎵 Sending first audio delta to Vonage (${evt.delta.length} chars base64)`);
            }
          } else {
            // Buffer until Vonage ready
            this.audioBuffer.push(evt.delta);
            if (this.audioBuffer.length === 1) {
              console.log(`📦 Buffering audio for ${this.conversationId} (Vonage not attached yet)`);
            }
          }
        }
        
        if (evt.type === 'response.done') {
          this.isAiSpeaking = false;
          if (this.greetingResponseId && evt.response.id === this.greetingResponseId) {
            this.greetingComplete = true;
            console.log(`🎉 Greeting complete in session ${this.conversationId}`);
            
            // Apply full knowledge if loaded
            if (this.fullInstructions) {
              this.applyFullKnowledge();
            }
          }
        }
        
        // Log any errors from OpenAI
        if (evt.type === 'error') {
          console.error(`❌ OpenAI error in ${this.conversationId}:`, JSON.stringify(evt.error));
        }
        
      } catch (err) {
        // Ignore parse errors
      }
    });

    this.ws.on('error', (error) => {
      console.error(`❌ OpenAI error in session ${this.conversationId}:`, error.message);
    });

    this.ws.on('close', () => {
      console.log(`🤖 OpenAI closed for session ${this.conversationId}`);
      this.ready = false;
    });
  }

  waitForReady() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Session ready timeout'));
      }, 15000);

      const checkReady = setInterval(() => {
        if (this.ready) {
          clearInterval(checkReady);
          clearTimeout(timeout);
          resolve();
        }
      }, 100);
    });
  }

  async fetchKnowledge() {
    try {
      const knowledgeUrl = `${process.env.REPLIT_APP_URL || 'https://myjoggle.replit.app'}/api/phone/knowledge/${this.businessId}`;
      const response = await fetch(knowledgeUrl);
      
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          this.welcomeGreeting = data.voiceConfig?.welcomeGreeting || this.welcomeGreeting;
          this.voiceConfig = data.voiceConfig || this.voiceConfig;
          this.knowledge = data.knowledge;
          this.languagePrompt = data.languagePrompt;
          this.voiceInstructions = data.voiceInstructions;
          
          // Build full instructions
          let instructions = "";
          if (this.languagePrompt) {
            instructions = `${this.languagePrompt}\n\n==========\n\n`;
          }
          instructions += "You are a helpful assistant.";
          if (this.knowledge) {
            instructions += `\n\nKNOWLEDGE BASE:\n${this.knowledge}`;
          }
          if (this.voiceInstructions) {
            instructions += this.voiceInstructions;
          }
          
          this.fullInstructions = instructions;
          console.log(`📚 Knowledge loaded for session ${this.conversationId} (${instructions.length} chars)`);
          
          // Apply knowledge immediately if greeting already done
          if (this.greetingComplete) {
            this.applyFullKnowledge();
          }
        }
      }
    } catch (error) {
      console.log(`⚠️ Knowledge fetch failed for ${this.conversationId}:`, error.message);
    }
  }

  applyFullKnowledge() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    // Update session with full knowledge - beta partial update
    const sessionConfig = {
      type: "session.update",
      session: {
        instructions: this.fullInstructions
      }
    };
    this.ws.send(JSON.stringify(sessionConfig));
    console.log(`✅ Applied full knowledge to session ${this.conversationId}`);
  }

  // Attach to Vonage call - provide callback to send audio
  attachToVonage(sendAudioCallback, onFirstAudioCallback = null) {
    if (this.attached) {
      console.warn(`⚠️ Session ${this.conversationId} already attached`);
      return;
    }
    
    this.attached = true;
    this.sendToVonage = sendAudioCallback;
    this.onFirstAudio = onFirstAudioCallback;
    console.log(`🔌 Vonage attached to session ${this.conversationId}`);
    
    // Flush buffered audio - sends immediately to Vonage
    if (this.audioBuffer.length > 0) {
      console.log(`🎵 Flushing ${this.audioBuffer.length} buffered audio deltas to Vonage`);
      this.audioBuffer.forEach(delta => {
        this.sendToVonage(delta);
        // Notify on first audio
        if (this.onFirstAudio && !this.firstAudioSent) {
          this.firstAudioSent = true;
          this.onFirstAudio();
        }
      });
      this.audioBuffer = [];
    }
  }

  // Send greeting instruction
  sendGreeting() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error(`❌ Cannot send greeting - session ${this.conversationId} not ready`);
      return false;
    }
    
    // Beta API: modalities INSIDE response object
    const triggerGreeting = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],  // Inside response for beta
        instructions: `Say: "${this.welcomeGreeting}"`
      }
    };
    
    this.ws.send(JSON.stringify(triggerGreeting));
    console.log(`👋 Greeting sent in session ${this.conversationId}`);
    return true;
  }

  // Send audio from Vonage to OpenAI
  sendAudioToOpenAI(base64Audio) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Audio
      }));
    }
  }

  // Clean up
  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Connection pool for pre-warmed sessions
const prewarmPool = new Map();

// Pre-warm session function
async function prewarmOpenAIConnection(conversationId, businessId) {
  console.log(`🔥 Starting pre-warm for conversation: ${conversationId}`);
  
  try {
    // Create and initialize session
    const session = new PrewarmedSession(conversationId, businessId);
    await session.initialize();
    
    // Store in pool with timestamp
    prewarmPool.set(conversationId, {
      session,
      timestamp: Date.now()
    });
    
    console.log(`✅ Pre-warm completed for ${conversationId}`);
    return session;
  } catch (error) {
    console.error(`❌ Pre-warm failed for ${conversationId}:`, error.message);
    prewarmPool.delete(conversationId);
    throw error;
  }
}

// Cleanup old pre-warmed sessions after 90 seconds
setInterval(() => {
  const now = Date.now();
  for (const [conversationId, data] of prewarmPool.entries()) {
    if (now - data.timestamp > 90000) {
      console.log(`🧹 Cleaning up expired pre-warmed session: ${conversationId}`);
      if (data.session) {
        data.session.close();
      }
      prewarmPool.delete(conversationId);
    }
  }
}, 15000);

// Add connection attempt logging
wss.on('headers', (headers, request) => {
  console.log("🔍 WebSocket upgrade attempt - Headers:", headers);
  console.log("🔍 Request headers:", request.headers);
  console.log("🔍 Request URL:", request.url);
});

wss.on("connection", async (vonageWS, request) => {
  console.log("📞 New Vonage WebSocket connection ESTABLISHED");
  console.log("📞 Request URL:", request.url);
  console.log("📞 Request headers:", JSON.stringify(request.headers, null, 2));
  
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const businessId = url.searchParams.get('business_id') || url.searchParams.get('assistant_id') || "default";
  const conversationId = (url.searchParams.get('conversation_id') || "unknown").toLowerCase(); // Normalize to lowercase
  const fromNumber = url.searchParams.get('from') || "unknown";
  const toNumber = url.searchParams.get('to') || "unknown";
  
  console.log(`🏢 Business: ${businessId}, Conversation: ${conversationId}`);
  console.log(`📞 From: ${fromNumber}, To: ${toNumber}`);
  
  // Track call start time for duration calculation
  const callStartTime = Date.now();
  
  // Create call log on main server
  const apiUrl = process.env.REPLIT_APP_URL || 'https://myjoggle.replit.app';
  const trackingSecret = process.env.CALL_TRACKING_SECRET;
  
  if (!trackingSecret) {
    console.error('❌ FATAL: CALL_TRACKING_SECRET environment variable is not set!');
    console.error('❌ Call tracking will be disabled. Conversation will NOT be logged or summarized.');
  }
  
  const callTrackingHeaders = trackingSecret ? {
    'Content-Type': 'application/json',
    'X-Call-Tracking-Secret': trackingSecret
  } : {
    'Content-Type': 'application/json'
  };
  
  // Start call logging in background (non-blocking) so Vonage handshake isn't delayed
  if (trackingSecret) {
    fetch(`${apiUrl}/api/phone/calls/start`, {
      method: 'POST',
      headers: callTrackingHeaders,
      body: JSON.stringify({
        conversationId,
        businessId,
        callerNumber: fromNumber,
        callNumber: toNumber
      })
    }).then(() => {
      console.log(`📝 Call log created for conversation: ${conversationId}`);
    }).catch(error => {
      console.error('❌ Failed to create call log:', error.message);
    });
  } else {
    console.warn('⚠️ Skipping call log creation - no tracking secret configured');
  }
  
  // Vonage-specific call state only
  let keepAliveInterval = null;
  let firstAudioReceived = false;
  let vonageStreamReady = false;
  let vonageConnected = false; // Track if Vonage sent websocket:connected
  let currentSession = null; // Will hold PrewarmedSession instance
  let lastAudioSent = 0; // Timestamp of last audio packet sent
  
  console.log("🔄 Call state initialized for conversation:", conversationId);
  
  // Acquire session (either pre-warmed or create new)
  async function acquireSession() {
    // Check for pre-warmed session
    if (prewarmPool.has(conversationId)) {
      const poolData = prewarmPool.get(conversationId);
      prewarmPool.delete(conversationId); // Remove from pool
      console.log(`🎯 Using pre-warmed session for ${conversationId}`);
      return poolData.session;
    }
    
    // No pre-warmed session - create new one
    console.log(`⚠️ No pre-warmed session - creating new session for ${conversationId}`);
    const session = new PrewarmedSession(conversationId, businessId);
    await session.initialize();
    return session;
  }
  
  // Audio queue with proper pacing (50 packets/sec)
  let audioPacketCount = 0;
  let leftoverBytes = Buffer.alloc(0);
  const audioQueue = [];
  let audioSender = null;
  
  const sendVonageAudio = (base64Audio) => {
    // OpenAI sends 24kHz PCM16, Vonage expects 16kHz PCM16
    const audioBuffer24k = Buffer.from(base64Audio, 'base64');
    const audioBuffer16k = resample24to16(audioBuffer24k);
    
    // Accumulate: prepend leftover bytes from previous call
    const combined = Buffer.concat([leftoverBytes, audioBuffer16k]);
    
    // Vonage expects EXACTLY 640 bytes per packet (20ms of 16kHz PCM16)
    // Queue packets for proper pacing
    const PACKET_SIZE = 640;
    let offset = 0;
    while (offset + PACKET_SIZE <= combined.length) {
      const chunk = combined.slice(offset, offset + PACKET_SIZE);
      audioQueue.push(chunk);
      offset += PACKET_SIZE;
    }
    
    // Save remaining bytes for next call
    leftoverBytes = combined.slice(offset);
    
    // Don't auto-start here - let the delayed start after websocket:connected handle it
  };
  
  const startAudioSender = () => {
    if (audioSender) {
      console.log("⚠️ Audio sender already running");
      return;
    }
    
    // Check ONCE at creation - not on every tick
    if (vonageWS.readyState !== WebSocket.OPEN) {
      console.log(`❌ Cannot start audio sender - WebSocket not OPEN (state: ${vonageWS.readyState})`);
      return;
    }
    
    const silenceBuffer = Buffer.alloc(640, 0);
    
    // Send at 50 packets/sec (one every 20ms)
    audioSender = setInterval(() => {
      try {
        // Check if WebSocket is still open
        if (vonageWS.readyState !== WebSocket.OPEN) {
          console.log(`⚠️ WebSocket closed mid-stream (state: ${vonageWS.readyState}), stopping sender`);
          clearInterval(audioSender);
          audioSender = null;
          return;
        }
        
        if (audioQueue.length > 0) {
          const chunk = audioQueue.shift();
          
          // Validate chunk before sending
          if (!Buffer.isBuffer(chunk) || chunk.length !== 640) {
            console.error(`❌ Invalid chunk: isBuffer=${Buffer.isBuffer(chunk)}, length=${chunk?.length}`);
            return;
          }
          
          vonageWS.send(chunk);
          audioPacketCount++;
          lastAudioSent = Date.now();
          
          if (audioPacketCount <= 10 || audioPacketCount % 100 === 0) {
            // Check if audio is actually not silence
            const hasAudio = chunk.some(byte => byte !== 0);
            console.log(`📤 Sent audio packet #${audioPacketCount} to Vonage (${audioQueue.length} queued, hasAudio: ${hasAudio})`);
          }
        } else {
          // Send silence to keep connection alive
          vonageWS.send(silenceBuffer);
          lastAudioSent = Date.now();
        }
      } catch (error) {
        console.error(`❌ Error in audio sender: ${error.message}`, error.stack);
        clearInterval(audioSender);
        audioSender = null;
      }
    }, 20);
    
    console.log(`🎵 Audio sender started (50 packets/sec, ${audioQueue.length} packets queued, WS state: ${vonageWS.readyState})`);
  };
  
  // Callback when first audio arrives
  const onFirstAudio = () => {
    if (!firstAudioReceived) {
      firstAudioReceived = true;
      console.log("🎵 First audio from OpenAI received");
    }
  };
  
  // Helper function to store conversation messages
  const storeMessage = async (role, content) => {
    if (!content || !trackingSecret) return;
    try {
      await fetch(`${apiUrl}/api/phone/calls/message`, {
        method: 'POST',
        headers: callTrackingHeaders,
        body: JSON.stringify({
          conversationId,
          role,
          content
        })
      });
    } catch (error) {
      console.error('❌ Failed to store message:', error.message);
    }
  }

  // ========================================
  // Vonage WebSocket Event Handlers
  // ========================================

  vonageWS.on("message", (raw) => {
    try {
      // Vonage sends BOTH JSON control messages AND raw binary audio
      const isBuffer = Buffer.isBuffer(raw);
      
      // Try to parse as JSON first
      const rawString = raw.toString();
      
      // Debug: Log first message received
      if (!firstAudioReceived && !vonageStreamReady) {
        console.log(`🔍 First Vonage message type: ${typeof raw}, isBuffer: ${isBuffer}, length: ${raw.length}`);
        console.log(`🔍 First 100 chars: ${rawString.substring(0, 100)}`);
      }
      
      // If it starts with {, it's a JSON control message
      if (rawString[0] === '{') {
        const msg = JSON.parse(rawString);
        console.log(`📋 Vonage event: ${msg.event}`);
        console.log(`📋 Full Vonage message:`, JSON.stringify(msg));
        
        if (msg.event === "websocket:connected") {
          console.log("📞 Vonage websocket:connected, content-type:", msg['content-type']);
          
          // CRITICAL: Send media_ready acknowledgement to complete handshake
          const mediaReadyResponse = {
            event: "websocket:media_ready"
          };
          vonageWS.send(JSON.stringify(mediaReadyResponse));
          console.log("✅ Sent websocket:media_ready acknowledgement");
          
          vonageConnected = true; // Mark as connected
          console.log("✅ Vonage WebSocket connected");
          
          // Acquire session first
          if (prewarmPool.has(conversationId)) {
            // FAST PATH: Pre-warmed session (synchronous)
            const poolData = prewarmPool.get(conversationId);
            prewarmPool.delete(conversationId);
            currentSession = poolData.session;
            console.log(`🎯 Using pre-warmed session for ${conversationId}`);
            console.log(`✅ Session acquired and ready for ${conversationId}`);
            
            // Attach immediately and start playing greeting
            console.log("🎬 Attaching session and starting audio playback...");
            currentSession.attachToVonage(sendVonageAudio, onFirstAudio);
            
            // Start audio sender immediately - Vonage may expect immediate transmission
            if (audioQueue.length > 0) {
              console.log(`🎵 Starting audio sender immediately with ${audioQueue.length} packets queued`);
              startAudioSender();
            } else {
              console.log("⚠️ No audio queued after attach");
            }
          } else {
            // SLOW PATH: Create new session (async)
            console.log(`⚠️ No pre-warmed session - creating new session for ${conversationId}`);
            (async () => {
              try {
                const session = new PrewarmedSession(conversationId, businessId);
                await session.initialize();
                currentSession = session;
                console.log(`✅ New session ready for ${conversationId}`);
                
                // Attach once ready
                currentSession.attachToVonage(sendVonageAudio, onFirstAudio);
                
                // Start audio sender immediately if we have queued audio
                if (audioQueue.length > 0) {
                  console.log(`🎵 Starting audio sender immediately with ${audioQueue.length} packets queued`);
                  startAudioSender();
                }
              } catch (error) {
                console.error(`❌ Failed to create session: ${error.message}`);
              }
            })();
          }
        }
      } else {
        // This is binary audio data (640 bytes of L16 PCM)
        if (isBuffer && raw.length === 640) {
          // First audio packet FROM user
          if (!vonageStreamReady) {
            vonageStreamReady = true;
            console.log("✅ Vonage receiving audio from user (first packet)");
          }
          
          // Forward audio to session
          if (currentSession && currentSession.ready) {
            const base64Audio = raw.toString('base64');
            currentSession.sendAudioToOpenAI(base64Audio);
          }
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
    console.error("❌ Vonage WebSocket error:", error.message || error);
    console.error("❌ Error stack:", error.stack);
    console.log(`🔍 DEBUG: Error occurred, WebSocket state: ${vonageWS.readyState}`);
    console.log(`🔍 DEBUG: Packets sent so far: ${audioPacketCount}, queue length: ${audioQueue.length}`);
  });

  vonageWS.on("close", async (code, reason) => {
    console.log(`📞 Vonage connection closed - Code: ${code}, Reason: ${reason || 'none'}`);
    console.log(`🔍 DEBUG: Close triggered after ${audioPacketCount} packets sent, ${audioQueue.length} still queued`);
    
    // Clean up audio sender
    if (audioSender) {
      clearInterval(audioSender);
      audioSender = null;
      console.log("🛑 Cleaned up audio sender");
    }
    
    
    // Close session
    if (currentSession) {
      currentSession.close();
    }
    
    // End call log and trigger summary
    const duration = Math.floor((Date.now() - callStartTime) / 1000);
    if (trackingSecret) {
      try {
        await fetch(`${apiUrl}/api/phone/calls/end`, {
          method: 'POST',
          headers: callTrackingHeaders,
          body: JSON.stringify({
            conversationId,
            duration
          })
        });
        console.log(`✅ Call ended - duration: ${duration}s - summary will be generated`);
      } catch (error) {
        console.error('❌ Failed to end call log:', error.message);
      }
    } else {
      console.warn('⚠️ Skipping call summary - no tracking secret configured');
    }
  });
});

function getBusinessInstructions(bizId) {
  const profiles = {
    wethreeloggerheads: `You are Joggle for We Three Loggerheads pub. Your PRIMARY GOAL: Understand exactly what the customer needs and help them.

APPROACH:
1. Listen carefully and let customers explain what they want
2. Ask clarifying questions to fully understand their needs
3. Confirm you've understood correctly before providing information
4. Be thorough - make sure they get everything they need

TONE: Warm, friendly, patient, and genuinely helpful. Make customers feel heard.

YOU CAN HELP WITH: Opening hours, food menu, drinks, events, bookings, general pub information, directions, accessibility, dietary requirements.

FOR TABLE BOOKINGS:
- First confirm their preferred date, time, and party size
- Check if they have any special requirements (high chairs, accessibility, dietary needs)
- Then collect: name, phone number
- Confirm all details back to them
- Let them know what to expect next

IMPORTANT: If you're not sure what they need, ask! Don't assume. Always check you've understood before moving on. Your job is to make sure they leave the call satisfied and with everything they needed.`,

    abbeygaragedoors: `You are Joggle for Abbey Garage Doors NW. Your PRIMARY GOAL: Understand the customer's garage door issue or need, and help them get the right solution.

APPROACH:
1. Listen to their situation - what's the problem or what do they need?
2. Ask questions to understand the full picture (type of door, urgency, what's wrong)
3. Check you've understood their situation correctly
4. Provide clear, practical help and next steps

TONE: Helpful, reassuring, practical, local UK. Make customers feel their problem is understood and being handled.

YOU CAN HELP WITH: Opening hours, service areas (North West England), new garage door quotes, repairs, emergency callouts, booking engineer visits, general advice.

FOR ISSUES/REPAIRS:
- First understand: What's happening? Is it urgent/safety issue? What type of door?
- Confirm you understand the situation
- Explain what can be done and timeframes
- If urgent/safety issue, reassure them and get contact details to prioritize

FOR NEW DOORS/QUOTES:
- Understand what they're looking for and why
- Ask about their requirements (size, style, automation)
- Explain the process for getting a quote
- Collect contact details and preferred callback time

IMPORTANT: Take time to understand before jumping to solutions. Garage doors can be complex - make sure you know what they actually need. If something's unclear, ask! Better to check than assume.`,

    default: `You are Joggle, this business's phone assistant. Your PRIMARY GOAL: Understand what the customer needs and genuinely help them.

APPROACH:
1. Listen carefully to what they want
2. Ask questions if anything is unclear
3. Confirm you understand their needs
4. Provide helpful, accurate information or assistance
5. Make sure they're satisfied before ending

TONE: Friendly, patient, professional. Make customers feel listened to and helped.

IMPORTANT PRINCIPLES:
- Don't rush - take time to understand what they really need
- Ask clarifying questions rather than guessing
- Confirm understanding: "Just to make sure I've got this right..."
- Be thorough - anticipate what else might help them
- If you can't help with something, be honest and offer alternatives
- Always check if there's anything else before finishing

Remember: A helpful conversation is better than a quick one. Your job is to make customers feel truly helped.`
  };
  return profiles[bizId] || profiles.default;
}

console.log(`🚀 Service started successfully on port ${PORT}`);
