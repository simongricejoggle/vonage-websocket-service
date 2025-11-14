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
  const { conversationId, businessId } = req.body;
  
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
    const testWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
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

// Connection pool for pre-warmed OpenAI sessions
const prewarmPool = new Map();

// Pre-warm OpenAI connection function
async function prewarmOpenAIConnection(conversationId, businessId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  console.log(`🔥 Starting pre-warm for conversation: ${conversationId}`);
  
  const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  // Store in pool immediately
  prewarmPool.set(conversationId, {
    ws,
    ready: false,
    businessId,
    timestamp: Date.now(),
    welcomeGreeting: "Hi, this is Joggle answering for your business.",
    voiceConfig: { voice: "ash", speed: 1.0 }
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error(`❌ Pre-warm timeout for ${conversationId} - cleaning up`);
      prewarmPool.delete(conversationId);
      ws.close();
      reject(new Error('Pre-warm connection timeout'));
    }, 15000);

    ws.on('open', () => {
      console.log(`✅ Pre-warmed OpenAI connected for ${conversationId}`);
      
      // Send minimal session config
      const sessionConfig = {
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: "You are a helpful assistant. When connected, greet the caller immediately.",
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 200,
                silence_duration_ms: 800,
                create_response: false
              }
            },
            output: { voice: "ash" }
          }
        }
      };
      
      ws.send(JSON.stringify(sessionConfig));
      
      // CRITICAL FIX: Mark as ready immediately after sending config
      // The setupPrewarmedConnection() handler will catch the actual session.updated event
      if (prewarmPool.has(conversationId)) {
        const poolData = prewarmPool.get(conversationId);
        poolData.ready = true;
        console.log(`🎯 Pre-warmed session marked ready: ${conversationId}`);
        clearTimeout(timeout);
        resolve();
      }
      
      // Fetch knowledge in background
      const knowledgeUrl = `${process.env.REPLIT_APP_URL || 'https://myjoggle.replit.app'}/api/phone/knowledge/${businessId}`;
      fetch(knowledgeUrl)
        .then(r => r.json())
        .then(data => {
          if (data.success && prewarmPool.has(conversationId)) {
            const poolData = prewarmPool.get(conversationId);
            poolData.welcomeGreeting = data.voiceConfig?.welcomeGreeting || poolData.welcomeGreeting;
            poolData.voiceConfig = data.voiceConfig || poolData.voiceConfig;
            poolData.knowledge = data.knowledge;
            poolData.languagePrompt = data.languagePrompt;
            poolData.voiceInstructions = data.voiceInstructions;
            console.log(`📚 Knowledge loaded for pre-warmed connection: ${conversationId}`);
          }
        })
        .catch(err => console.log(`⚠️ Knowledge fetch failed:`, err.message));
    });

    ws.on('error', (error) => {
      console.error(`❌ Pre-warm WebSocket error for ${conversationId}:`, error.message);
      clearTimeout(timeout);
      prewarmPool.delete(conversationId);
      reject(error);
    });

    ws.on('close', () => {
      console.log(`📞 Pre-warmed connection closed: ${conversationId}`);
      clearTimeout(timeout);
    });
  });
}

// Cleanup old pre-warmed connections after 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [conversationId, data] of prewarmPool.entries()) {
    if (now - data.timestamp > 30000) {
      console.log(`🧹 Cleaning up expired pre-warmed connection: ${conversationId}`);
      if (data.ws && data.ws.readyState === WebSocket.OPEN) {
        data.ws.close();
      }
      prewarmPool.delete(conversationId);
    }
  }
}, 5000);

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
  const conversationId = url.searchParams.get('conversation_id') || "unknown";
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
  
  // CRITICAL: Reset ALL state for each new call (prevent state leakage between calls)
  let openaiWS = null;
  let openaiReady = false;
  let vonageStreamReady = false;
  let greetingSent = false;
  let welcomeGreeting = "Hi, this is Joggle answering for your business.";
  let keepAliveInterval = null;
  let firstAudioReceived = false;  // Track when first audio arrives to stop keep-alive
  let greetingResponseId = null;  // Track greeting response to defer full session update
  let fullKnowledgeData = null;  // Store full knowledge/voice config for deferred session update
  let greetingComplete = false;  // Track if greeting has finished (for late knowledge application)
  
  // Interruption handling state
  let activeResponseId = null;
  let activeItemId = null;  // Track current output item for truncation
  let isAiSpeaking = false;
  let audioQueue = [];  // Buffer for queued audio packets
  let pendingResponseCreate = false;  // Flag to defer response.create until cancel confirmed
  let cancelTimeout = null;  // Timeout to prevent deadlock
  let earlyAudioBuffer = [];  // Buffer audio deltas that arrive before Vonage is ready
  
  console.log("🔄 Call state initialized for conversation:", conversationId);
  
  // Helper function to setup pre-warmed connection with event handlers
  const setupPrewarmedConnection = (poolData) => {
    console.log(`🔌 Setting up pre-warmed connection event handlers`);
    
    // Helper to send messages to OpenAI
    const sendOpenAI = (data) => {
      if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify(data));
      }
    };
    
    // Listen for session.updated events to mark as ready
    openaiWS.on('message', (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        
        if (evt.type === 'session.updated' && !openaiReady) {
          openaiReady = true;
          console.log(`✅ Pre-warmed session confirmed ready`);
          trySendGreeting();
        }
        
        // Handle response lifecycle
        if (evt.type === "response.created") {
          activeResponseId = evt.response.id;
          console.log(`🎯 Response created: ${activeResponseId}`);
          
          if (greetingResponseId === null) {
            greetingResponseId = activeResponseId;
            console.log(`🎤 Greeting response ID captured: ${greetingResponseId}`);
          }
        }
        
        if (evt.type === "response.output_item.added") {
          activeItemId = evt.item.id;
          isAiSpeaking = true;
          console.log(`🔊 AI started speaking - item: ${activeItemId}`);
        }
        
        if (evt.type === "response.output_audio.delta" && evt.delta) {
          if (!firstAudioReceived) {
            firstAudioReceived = true;
            if (keepAliveInterval) {
              clearInterval(keepAliveInterval);
              keepAliveInterval = null;
              console.log("🛑 Stopped keep-alive (first real audio from pre-warmed)");
            }
          }
          
          if (isAiSpeaking) {
            if (!vonageStreamReady) {
              earlyAudioBuffer.push(evt.delta);
            } else {
              sendVonageAudio(evt.delta);
            }
          }
        }
        
        if (evt.type === "response.done") {
          isAiSpeaking = false;
          console.log(`✅ Response completed`);
          
          if (greetingResponseId && evt.response.id === greetingResponseId) {
            greetingComplete = true;
            console.log(`🎉 Greeting finished successfully`);
            
            // Apply full knowledge if it loaded
            if (fullKnowledgeData) {
              sendOpenAI({
                type: "session.update",
                session: {
                  type: "realtime",
                  model: "gpt-realtime",
                  instructions: fullKnowledgeData.instructions,
                  audio: {
                    input: {
                      turn_detection: {
                        type: "server_vad",
                        threshold: 0.5,
                        prefix_padding_ms: 200,
                        silence_duration_ms: 800,
                        create_response: false
                      }
                    },
                    output: { voice: fullKnowledgeData.voiceConfig?.voice || "ash" }
                  }
                }
              });
              console.log(`✅ Session updated with full knowledge from pre-warmed connection`);
            }
          }
        }
      } catch (err) {
        // Ignore parse errors
      }
    });
    
    openaiWS.on('error', (error) => {
      console.error("❌ Pre-warmed OpenAI error:", error);
    });
    
    openaiWS.on('close', () => {
      console.log("🤖 Pre-warmed OpenAI closed");
      openaiReady = false;
    });
  };
  
  // Helper function to send greeting when both systems are ready
  const trySendGreeting = () => {
    console.log(`🔍 trySendGreeting() called - greetingSent: ${greetingSent}, vonageReady: ${vonageStreamReady}, openaiReady: ${openaiReady}`);
    
    if (greetingSent) {
      console.log(`✅ Greeting already sent, skipping`);
      return;
    }
    
    if (!vonageStreamReady) {
      console.log(`⏳ Waiting for Vonage stream to be ready...`);
      return;
    }
    
    if (!openaiReady || !openaiWS || openaiWS.readyState !== WebSocket.OPEN) {
      console.log(`⏳ Waiting for OpenAI connection to be ready...`);
      return;
    }
    
    // All systems ready - send greeting immediately!
    console.log(`🎯 ALL SYSTEMS READY - Sending greeting NOW!`);
    
    // CRITICAL FIX: Use response.create with instructions to speak the greeting immediately
    // This avoids creating a user message that OpenAI would need to respond to
    sendOpenAI({ 
      type: "response.create",
      response: {
        instructions: `Say this exact greeting immediately: "${welcomeGreeting}"`
      }
    });
    
    greetingSent = true;
    console.log(`✅ Greeting sent successfully`);
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
    
    console.log(`🤖 Creating OpenAI connection for business: ${businessId}`);
    console.log(`⚡ FAST MODE: Connecting to OpenAI immediately, fetching knowledge in parallel`);
    
    // CONNECT TO OPENAI IMMEDIATELY (don't wait for knowledge fetch)
    openaiWS = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    
    // FETCH KNOWLEDGE IN PARALLEL (don't block OpenAI connection)
    let voiceConfig = { voice: "alloy", speed: 1.0 };
    const knowledgePromise = (async () => {
      let knowledge = "";
      let voiceInstructions = "";
      let languagePrompt = "";
      
      try {
        const knowledgeUrl = `${process.env.REPLIT_APP_URL || 'https://myjoggle.replit.app'}/api/phone/knowledge/${businessId}`;
        console.log(`📚 Fetching knowledge from: ${knowledgeUrl}`);
        
        const response = await fetch(knowledgeUrl);
        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            knowledge = data.knowledge || "";
            voiceConfig = data.voiceConfig || { voice: "alloy", speed: 1.0 };
            voiceInstructions = data.voiceInstructions || "";
            languagePrompt = data.languagePrompt || "";
            // Store welcome greeting in outer scope for trySendGreeting()
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
      
      // Combine instructions
      let instructions = "";
      if (languagePrompt) {
        instructions = `${languagePrompt}\n\n==========\n\n`;
      }
      instructions += baseInstructions;
      if (knowledge) {
        instructions += `\n\nKNOWLEDGE BASE:\n${knowledge}`;
      }
      if (voiceInstructions) {
        instructions += voiceInstructions;
      }
      if (!voiceConfig.language || voiceConfig.language === 'en-GB' || voiceConfig.language === 'en-US') {
        instructions += "\n\nIMPORTANT: Always respond in English only.";
      }
      
      return { knowledge, voiceConfig, instructions };
    })();

    openaiWS.on("open", async () => {
      console.log("🤖 OpenAI Realtime session connected");
      
      // Configure with minimal session immediately (base instructions only)
      console.log("⚡ Configuring minimal session for immediate greeting...");
      const minimalSessionConfig = {
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: baseInstructions, // Just the base instructions, no knowledge yet
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 200,
                silence_duration_ms: 800,
                create_response: false
              }
            },
            output: { 
              voice: voiceConfig.voice || "ash" // Use default voice first
            }
          }
        }
      };
      
      sendOpenAI(minimalSessionConfig);
      // DON'T set openaiReady here - wait for session.updated event!
      console.log("⏳ Waiting for session.updated confirmation...");
      
      // Load full knowledge in background (will be applied AFTER greeting finishes)
      knowledgePromise.then(({ voiceConfig: finalVoiceConfig, instructions }) => {
        console.log("📚 Background: Full knowledge loaded");
        console.log("📝 Full instructions length:", instructions.length);
        
        // Store knowledge data
        fullKnowledgeData = {
          voiceConfig: finalVoiceConfig,
          instructions: instructions
        };
        
        // If greeting already finished, apply knowledge immediately
        if (greetingComplete && openaiWS && openaiWS.readyState === WebSocket.OPEN) {
          console.log("🎉 Greeting already done - applying knowledge now!");
          const fullSessionConfig = {
            type: "session.update",
            session: {
              type: "realtime",
              model: "gpt-realtime",
              instructions: instructions,
              audio: {
                input: {
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 200,
                    silence_duration_ms: 800,
                    create_response: false
                  }
                },
                output: { voice: finalVoiceConfig.voice }
              }
            }
          };
          
          if (finalVoiceConfig.speed && finalVoiceConfig.speed !== 1.0) {
            fullSessionConfig.session.speed = finalVoiceConfig.speed;
          }
          
          sendOpenAI(fullSessionConfig);
          console.log("✅ Session updated with full knowledge (late arrival)");
        }
      }).catch(error => {
        console.error("❌ Failed to load knowledge in background:", error);
      });
    });

    openaiWS.on("message", (raw) => {
      try {
        const evt = JSON.parse(raw.toString());
        
        // Log important events for debugging
        if (evt.type && !evt.type.includes('.delta')) {
          console.log(`🔔 OpenAI event: ${evt.type}`);
        }
        
        // CRITICAL: Wait for session.updated before marking OpenAI as ready
        if (evt.type === "session.updated") {
          if (!openaiReady) {
            openaiReady = true;
            console.log("✅ Session confirmed ready - can now send greeting");
            // Trigger greeting now that session is confirmed ready
            trySendGreeting();
          }
        }
        
        // Track response lifecycle for interruption handling
        if (evt.type === "response.created") {
          activeResponseId = evt.response?.id || null;
          pendingResponseCreate = false;  // Clear pending flag
          console.log(`🎯 Response created: ${activeResponseId}`);
          
          // Capture the greeting response ID (first response after greetingSent)
          if (greetingSent && !greetingResponseId) {
            greetingResponseId = activeResponseId;
            console.log(`🎤 Greeting response ID captured: ${greetingResponseId}`);
          }
        } else if (evt.type === "response.output_item.added") {
          // Track output item ID for potential truncation
          activeItemId = evt.item?.id || null;
          isAiSpeaking = true;
          console.log(`🔊 AI started speaking - item: ${activeItemId}`);
        } else if (evt.type === "response.output_audio.delta" && !isAiSpeaking) {
          // Fallback if we missed output_item.added
          isAiSpeaking = true;
          console.log("🔊 AI started speaking (via audio delta)");
        } else if (evt.type === "input_audio_buffer.speech_started") {
          // User started speaking
          if (isAiSpeaking && activeResponseId) {
            // INTERRUPTION DETECTED - Cancel AI response immediately
            console.log(`⚠️ INTERRUPTION: User speaking, canceling AI response ${activeResponseId}`);
            
            // 1. Cancel the active response immediately
            sendOpenAI({ 
              type: "response.cancel",
              response_id: activeResponseId
            });
            
            // 2. Truncate the conversation to remove incomplete AI message
            // This ensures the partial response doesn't appear in conversation history
            if (activeItemId) {
              sendOpenAI({
                type: "conversation.item.truncate",
                item_id: activeItemId,
                content_index: 0,
                audio_end_ms: 0
              });
              console.log(`✂️ Truncated conversation item: ${activeItemId}`);
            }
            
            // 3. Clear audio queue to stop all pending audio immediately
            audioQueue = [];
            
            // 4. Clear AI speaking state
            isAiSpeaking = false;
            
            console.log("⏸️ AI interrupted - ready for user input");
          } else {
            console.log("🎤 User started speaking");
          }
        } else if (evt.type === "input_audio_buffer.speech_stopped") {
          console.log("🎤 User stopped speaking");
          
          // Only create response if no active response exists
          if (!activeResponseId) {
            sendOpenAI({ type: "response.create" });
          } else {
            // Defer response.create until cancellation is confirmed
            pendingResponseCreate = true;
            console.log("⏳ Deferring response.create until cancellation confirmed");
            
            // Fallback timeout to prevent deadlock (500ms)
            if (cancelTimeout) clearTimeout(cancelTimeout);
            cancelTimeout = setTimeout(() => {
              if (pendingResponseCreate) {
                console.log("⏰ Cancel timeout - forcing response.create");
                pendingResponseCreate = false;
                activeResponseId = null;
                sendOpenAI({ type: "response.create" });
              }
            }, 500);
          }
        } else if (evt.type === "response.done" || evt.type === "response.cancelled") {
          // AI finished or was cancelled
          isAiSpeaking = false;
          const wasCancelled = evt.type === "response.cancelled";
          console.log(wasCancelled ? "🚫 Response cancelled" : "✅ Response completed");
          
          // CRITICAL: Check if this is the greeting response BEFORE clearing greetingResponseId
          const isGreetingResponse = greetingResponseId && evt.response?.id === greetingResponseId;
          
          // Error recovery: If GREETING was cancelled, reset state to allow retry
          if (wasCancelled && isGreetingResponse) {
            console.log("⚠️ Greeting was cancelled - resetting state for retry");
            greetingSent = false;
            greetingResponseId = null;
            firstAudioReceived = false;
            greetingComplete = false;
          }
          // If greeting completed successfully, update session with full knowledge
          else if (!wasCancelled && isGreetingResponse) {
            console.log("🎉 Greeting finished successfully");
            greetingComplete = true;  // Mark greeting as complete
            greetingResponseId = null;  // Clear so we don't re-trigger
            
            // Send full session update if knowledge is ready NOW
            if (fullKnowledgeData) {
              const { voiceConfig: finalVoiceConfig, instructions } = fullKnowledgeData;
              const fullSessionConfig = {
                type: "session.update",
                session: {
                  type: "realtime",
                  model: "gpt-realtime",
                  instructions: instructions, // Full knowledge now included
                  audio: {
                    input: {
                      turn_detection: {
                        type: "server_vad",
                        threshold: 0.5,
                        prefix_padding_ms: 200,
                        silence_duration_ms: 800,
                        create_response: false
                      }
                    },
                    output: { 
                      voice: finalVoiceConfig.voice
                    }
                  }
                }
              };
              
              // Add speed if configured
              if (finalVoiceConfig.speed && finalVoiceConfig.speed !== 1.0) {
                fullSessionConfig.session.speed = finalVoiceConfig.speed;
              }
              
              sendOpenAI(fullSessionConfig);
              console.log("✅ Session updated with full knowledge and voice settings");
            } else {
              console.log("⏳ Knowledge not ready yet - will apply when it arrives");
            }
          }
          
          // Clear active response and item
          activeResponseId = null;
          activeItemId = null;
          
          // If we have a pending response.create, trigger it now
          if (pendingResponseCreate) {
            pendingResponseCreate = false;
            if (cancelTimeout) {
              clearTimeout(cancelTimeout);
              cancelTimeout = null;
            }
            console.log("✅ Cancellation confirmed - creating new response");
            sendOpenAI({ type: "response.create" });
          }
        } else if (evt.type === "conversation.item.created") {
          // Track conversation messages
          const item = evt.item;
          if (item.role && item.content) {
            const textContent = item.content
              .filter(c => c.type === 'text' || c.type === 'input_text')
              .map(c => c.text)
              .join(' ');
            
            if (textContent) {
              storeMessage(item.role, textContent);
            }
          }
        } else if (evt.type === "response.audio_transcript.done") {
          // Track assistant's transcribed speech
          if (evt.transcript) {
            storeMessage('assistant', evt.transcript);
          }
        }
        
        // GA API uses response.output_audio.delta (not response.audio.delta)
        if (evt.type === "response.output_audio.delta" && evt.delta) {
          // CRITICAL: Stop keep-alive on FIRST audio delta
          if (!firstAudioReceived) {
            firstAudioReceived = true;
            if (keepAliveInterval) {
              clearInterval(keepAliveInterval);
              keepAliveInterval = null;
              console.log("🛑 Stopped keep-alive (first real audio received from OpenAI)");
            }
          }
          
          // Only forward audio if AI is still speaking (not interrupted)
          if (isAiSpeaking) {
            // CRITICAL FIX: Buffer audio if Vonage isn't ready yet
            if (!vonageStreamReady) {
              earlyAudioBuffer.push(evt.delta);
              if (earlyAudioBuffer.length === 1) {
                console.log("⏳ Buffering audio - Vonage not ready yet");
              }
            } else {
              sendVonageAudio(evt.delta);
            }
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

  vonageWS.on("message", (raw) => {
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
          console.log("📞 Vonage websocket:connected, content-type:", msg['content-type']);
          console.log("⏳ Waiting for media bridge to fully establish (will mark ready on first audio packet)...");
          
          // DON'T mark vonageStreamReady here - wait for first binary audio packet!
          // The websocket:connected event fires BEFORE the media bridge is actually open
          
          // CRITICAL FIX: Only start keep-alive if we haven't received real audio yet
          if (!firstAudioReceived) {
            const silenceBuffer = Buffer.alloc(640, 0); // 20ms of silence (640 bytes = 320 samples @ 16kHz)
            
            // Send first silence packet immediately (synchronous - no delay)
            console.log("🔇 Starting silence keep-alive at proper rate (50 packets/second)...");
            if (vonageWS.readyState === WebSocket.OPEN) {
              vonageWS.send(silenceBuffer);
            }
            
            // Start keep-alive interval IMMEDIATELY at correct pace (20ms = 50 packets/second)
            // Keep running until FIRST real audio arrives from OpenAI (not just when openaiReady flag is set)
            keepAliveInterval = setInterval(() => {
              if (vonageWS.readyState === WebSocket.OPEN) {
                vonageWS.send(silenceBuffer);
              } else {
                // Stop only if Vonage disconnected
                if (keepAliveInterval) {
                  clearInterval(keepAliveInterval);
                  keepAliveInterval = null;
                  console.log("🛑 Stopped silence keep-alive (Vonage disconnected)");
                }
              }
            }, 20); // 20ms intervals = 50 packets/second (Vonage's expected audio rate)
          } else {
            console.log("✅ Skipping keep-alive - real audio already received");
          }
          
          // Check if we have a pre-warmed connection ready
          if (prewarmPool.has(conversationId)) {
            console.log(`🎯 Found pre-warmed connection for ${conversationId} - using it!`);
            const poolData = prewarmPool.get(conversationId);
            
            // CRITICAL: Remove from pool immediately to prevent cleanup timer from closing it
            prewarmPool.delete(conversationId);
            
            // Use the pre-warmed connection
            openaiWS = poolData.ws;
            welcomeGreeting = poolData.welcomeGreeting;
            
            // CRITICAL: Populate fullKnowledgeData so knowledge gets applied after greeting
            if (poolData.knowledge) {
              let instructions = "";
              if (poolData.languagePrompt) {
                instructions = `${poolData.languagePrompt}\n\n==========\n\n`;
              }
              instructions += "You are a helpful assistant.";
              instructions += `\n\nKNOWLEDGE BASE:\n${poolData.knowledge}`;
              if (poolData.voiceInstructions) {
                instructions += poolData.voiceInstructions;
              }
              
              fullKnowledgeData = {
                voiceConfig: poolData.voiceConfig,
                instructions: instructions
              };
              console.log(`📚 Knowledge loaded from pre-warmed connection (${instructions.length} chars)`);
            }
            
            // If already ready, mark it immediately
            if (poolData.ready) {
              openaiReady = true;
              console.log(`⚡ Pre-warmed connection already ready - can send greeting now!`);
              
              // Set up event handlers for the pre-warmed connection
              setupPrewarmedConnection(poolData);
              
              // Try sending greeting immediately
              trySendGreeting();
            } else {
              console.log(`⏳ Pre-warmed connection still initializing...`);
              // Set up event handlers and wait for ready
              setupPrewarmedConnection(poolData);
            }
          } else {
            console.log(`⚠️ No pre-warmed connection found for ${conversationId} - falling back to creating new one`);
            // Fallback to creating new connection
            createOpenAIConnection().catch(error => {
              console.error("❌ Fatal error in OpenAI connection setup:", error);
            });
          }
        }
      } else {
        // This is binary audio data (640 bytes of L16 PCM)
        if (isBuffer && raw.length === 640) {
          // CRITICAL: First audio packet confirms media bridge is actually ready
          if (!vonageStreamReady) {
            vonageStreamReady = true;
            console.log("✅ Vonage media bridge ready (first audio packet received)");
            
            // CRITICAL: Flush any buffered audio that arrived before Vonage was ready
            if (earlyAudioBuffer.length > 0) {
              console.log(`🎵 Flushing ${earlyAudioBuffer.length} buffered audio deltas to Vonage`);
              earlyAudioBuffer.forEach(delta => sendVonageAudio(delta));
              earlyAudioBuffer = [];
            }
            
            // Now try sending greeting (OpenAI might already be ready)
            trySendGreeting();
          }
          
          // Forward audio to OpenAI if ready
          if (openaiReady) {
            const base64Audio = raw.toString('base64');
            sendOpenAI({
              type: "input_audio_buffer.append",
              audio: base64Audio
            });
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
    console.error("❌ Vonage WebSocket error:", error);
  });

  vonageWS.on("close", async () => {
    console.log("📞 Vonage connection closed");
    
    // Clean up keep-alive interval
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
      console.log("🛑 Cleaned up keep-alive interval");
    }
    
    // Clean up cancel timeout
    if (cancelTimeout) {
      clearTimeout(cancelTimeout);
      cancelTimeout = null;
    }
    
    if (openaiWS) openaiWS.close();
    
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
