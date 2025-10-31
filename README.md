# Vonage WebSocket Service

Standalone WebSocket service for handling Vonage voice calls with OpenAI Realtime API.

## Why This Exists

Replit's infrastructure adds WebSocket compression that Vonage doesn't support. This service runs on Railway.app (or similar) without that limitation.

## Architecture

```
Caller → Vonage → [This Service] → OpenAI Realtime API
                        ↓
                   Main Joggle App (for NCCO generation)
```

## Deployment to Railway.app

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/vonage-websocket-service.git
git push -u origin main
```

### 2. Deploy on Railway

1. Go to [railway.app](https://railway.app)
2. Sign in with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select this repository
5. Railway auto-detects Node.js and deploys

### 3. Configure Environment Variables

In Railway dashboard → Variables tab, add:

- `OPENAI_API_KEY` - Your OpenAI API key (required)
- `VOICE_NAME` - Voice to use (optional, default: alloy)
- `VAD_THRESHOLD` - Voice detection threshold (optional, default: 0.5)
- `VAD_PREFIX_MS` - VAD prefix padding (optional, default: 200)
- `VAD_SILENCE_MS` - VAD silence duration (optional, default: 300)

### 4. Generate Public Domain

1. Railway dashboard → Settings → Networking
2. Click "Generate Domain"
3. You'll get: `your-app.up.railway.app`

### 5. Update Main Joggle App

In your Replit project, update `server/plugins/phone/ncco.ts`:

Change:
```typescript
uri: `wss://joggle.ai/plugins/phone/stream?...`
```

To:
```typescript
uri: `wss://your-app.up.railway.app/plugins/phone/stream?...`
```

## Testing

1. Check health endpoint: `https://your-app.up.railway.app/`
2. Make a test call to your Vonage number
3. Watch Railway logs for connection activity

## Endpoints

- `GET /` - Health check (returns JSON status)
- `GET /health` - Simple health check
- `WS /plugins/phone/stream` - Vonage WebSocket endpoint

## Query Parameters for WebSocket

- `business_id` or `assistant_id` - Which business profile to use
- `conversation_id` - Vonage conversation UUID
- `from` - Caller's phone number
- `to` - Called phone number

## Business Profiles

Currently configured:
- `wethreeloggerheads` - We Three Loggerheads pub
- `abbeygaragedoors` - Abbey Garage Doors
- `default` - Generic assistant

To add more, edit the `getBusinessInstructions()` function in `index.js`.

## Troubleshooting

**Connection fails:**
- Check Railway logs for errors
- Verify OPENAI_API_KEY is set
- Ensure Railway generated a public domain

**Audio issues:**
- Check VAD settings (threshold, silence duration)
- Verify OpenAI API key has Realtime API access

**Deployment hangs:**
- Ensure `package.json` has `"start": "node index.js"`
- Check Railway build logs for npm install errors

## Cost

Railway pricing: ~$5-10/month for small usage
(First $5 is free trial credits)

## Support

For issues, check:
1. Railway deployment logs
2. Main Joggle app logs
3. Vonage Voice Inspector for call diagnostics
