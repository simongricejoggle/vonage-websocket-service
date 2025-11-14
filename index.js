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

// NCCO Answer Webhook - Vonage calls this to get call instructions
app.get('/plugins/phone/voice', (req, res) => {
  console.log('📞 Vonage Answer Webhook called', {
    from: req.query.from,
    to: req.query.to,
    conversation_uuid: req.query.conversation_uuid
  });

  const host = req.get('host'); // Railway domain
  const from = req.query.from || 'unknown';
  const to = req.query.to || 'unknown';
  const conversationId = req.query.conversation_uuid || `${from}_${Date.now()}`;
  const businessId = 'wethreeloggerheads'; // Default for We Three Loggerheads

  // Build WebSocket URL on same Railway host (no Cloudflare)
  const wsUrl = `wss://${host}/plugins/phone/stream?business_id=${encodeURIComponent(businessId)}&assistant_id=${encodeURIComponent(businessId)}&conversation_id=${encodeURIComponent(conversationId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const replit_url = process.env.REPLIT_APP_URL || 'https://joggle.ai';
  
  // Return NCCO with record + WebSocket connect
  const ncco = [
    {
      action: "record",
      eventUrl: [`${replit_url}/plugins/phone/recording`],
      endOnSilence: 3,
      format: "wav",
      split: "conversation",
      channels: 1,
      beepStart: false
    },
    {
      action: "connect",
      eventType: "synchronous",
      timeout: 10,
      eventUrl: [`${replit_url}/plugins/phone/event`],
      from: from,
      endpoint: [
        {
          type: "websocket",
          uri: wsUrl,
          "content-type": "audio/l16;rate=16000"
        }
      ]
    }
  ];

  console.log('📞 Returning NCCO:', JSON.stringify(ncco, null, 2));
  
  // Set proper headers to prevent caching
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json(ncco);
});

const wss = new WebSocketServer({ 
  server,
  path: "/plugins/phone/stream",
  perMessageDeflate: false,
  clientNoContextTakeover: true,
  serverNoContextTakeover: true
});

console.log("🎤 WebSocket server registered on /plugins/phone/stream");

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
  
  let openaiWS = null;
  let openaiReady = false;
  let vonageStreamReady = false;
  let greetingSent = false;
  let welcomeGreeting = "Hi, this is Joggle answering for your business.";
  let keepAliveInterval = null;
  
  // Interruption handling state
  let activeResponseId = null;
  let activeItemId = null;  // Track current output item for truncation
  let isAiSpeaking = false;
  let audioQueue = [];  // Buffer for queued audio packets
  let pendingResponseCreate = false;  // Flag to defer response.create until cancel confirmed
  let cancelTimeout = null;  // Timeout to prevent deadlock
  
  // Helper function to send greeting when both systems are ready
  const trySendGreeting = () => {
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
    
    // Stop keep-alive - OpenAI will now send real audio
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
      console.log(`🛑 Stopped keep-alive silence (OpenAI will send real audio now)`);
    }
    
    // All systems ready - send greeting!
    console.log(`👋 Sending custom greeting (all systems ready)...`);
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
      console.log("⏳ Waiting for knowledge to load...");
      
      // Wait for knowledge fetch to complete
      const { voiceConfig: finalVoiceConfig, instructions } = await knowledgePromise;
      
      console.log("✅ Knowledge loaded, configuring session...");
      
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
      
      // Add speed if configured (and not default)
      if (finalVoiceConfig.speed && finalVoiceConfig.speed !== 1.0) {
        sessionConfig.session.speed = finalVoiceConfig.speed;
        console.log(`⚡ Voice speed set to: ${finalVoiceConfig.speed}x`);
      }
      
      sendOpenAI(sessionConfig);
      openaiReady = true;
      console.log("✅ OpenAI session configured, ready for audio");
      console.log("📝 Full instructions length:", instructions.length);
      
      // Try sending greeting if Vonage is already ready
      trySendGreeting();
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
          pendingResponseCreate = false;  // Clear pending flag
          console.log(`🎯 Response created: ${activeResponseId}`);
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
          
          // CRITICAL: Send immediate silence AND start periodic keep-alive
          // Vonage expects bidirectional audio immediately or it closes the connection
          console.log("🔇 Starting keep-alive silence to Vonage (prevents premature disconnect)");
          const silenceBuffer = Buffer.alloc(640, 0); // 20ms of silence (640 bytes = 320 samples @ 16kHz)
          
          // Send first silence immediately
          if (vonageWS.readyState === WebSocket.OPEN) {
            vonageWS.send(silenceBuffer);
          }
          
          // Keep sending silence every 20ms until OpenAI is ready
          keepAliveInterval = setInterval(() => {
            if (vonageWS.readyState === WebSocket.OPEN && !openaiReady) {
              vonageWS.send(silenceBuffer);
            } else if (openaiReady || vonageWS.readyState !== WebSocket.OPEN) {
              // Stop if OpenAI is ready or Vonage disconnected
              if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
              }
            }
          }, 20); // 20ms intervals (matching Vonage's audio packet rate)
          
          // Mark Vonage as ready
          vonageStreamReady = true;
          
          // Start OpenAI connection in background (non-blocking)
          createOpenAIConnection().catch(error => {
            console.error("❌ Fatal error in OpenAI connection setup:", error);
          });
          
          // Try sending greeting (will wait for OpenAI if not ready yet)
          trySendGreeting();
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
