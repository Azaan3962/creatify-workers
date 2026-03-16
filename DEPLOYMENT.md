# Creatify Puppeteer Worker — Deployment Guide

## Files in this repo
```
creatify-worker/
├── server.js        ← The automation server
├── Dockerfile       ← Railway container definition
├── package.json     ← Node dependencies
├── .dockerignore    ← Keeps image small
└── .gitignore       ← Never commit secrets
```

---

## Deploy to Railway (step by step)

### Step 1 — Connect repo on Railway
1. Go to [railway.app](https://railway.app) → New Project
2. Click **GitHub Repository**
3. Select **creatify-worker**
4. Railway auto-detects the Dockerfile and starts building ✅

---

### Step 2 — Add environment variable
1. Click your service → **Variables** tab
2. Click **New Variable** and add:
```
BOOMLIFY_API_KEY = api_11db5c08a25e133dac9b1cc5264105c9933c32b4f92fb5a03e3f6d814c7e62e3
```

---

### Step 3 — Set memory to 2GB (required for Chrome)
1. Click your service → **Settings** tab
2. Scroll to **Resources**
3. Set Memory → **2048 MB**

> Chrome/Puppeteer crashes with less than 2GB — this step is critical.

---

### Step 4 — Get your public URL
1. Click your service → **Settings** tab
2. Scroll to **Networking**
3. Click **Generate Domain**
4. You'll get a URL like:
```
https://creatify-worker-production.up.railway.app
```

---

### Step 5 — Test it
Open any REST client or browser and POST to:
```
POST https://YOUR-RAILWAY-URL.up.railway.app/run
Content-Type: application/json

{
  "productUrl": "https://example.com",
  "jobId": "test-001"
}
```

Expected response:
```json
{ "success": true, "videoUrls": [], "jobId": "test-001" }
```

Health check (paste in browser):
```
https://YOUR-RAILWAY-URL.up.railway.app/health
→ { "status": "ok" }
```

---

### Step 6 — Auto-deploys
Every time you push to GitHub, Railway rebuilds automatically. No manual steps needed.

---

## n8n Workflow — 7 nodes

### Node 1: Webhook
- Type: `Webhook`
- Method: `POST`
- Path: `generate-video`
- Response Mode: `Using 'Respond to Webhook' Node`

### Node 2: Set
- Name: `Set variables`
- Fields:
  - `jobId` → `{{ $json.jobId }}`
  - `productUrl` → `{{ $json.productUrl }}`
  - `userId` → `{{ $json.userId }}`

### Node 3: HTTP Request — Mark job "processing"
- Method: `POST`
- URL: `https://haissqtlduybusjzzfsh.supabase.co/functions/v1/update-job`
- Headers:
  - `Authorization`: `Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY`
  - `Content-Type`: `application/json`
- Body:
```json
{
  "jobId": "{{ $('Set variables').item.json.jobId }}",
  "status": "processing",
  "videoUrls": []
}
```

### Node 4: HTTP Request — Call Puppeteer worker
- Method: `POST`
- URL: `https://YOUR-RAILWAY-URL.up.railway.app/run`
- Timeout: `300000` (5 minutes in ms)
- Body:
```json
{
  "jobId": "{{ $('Set variables').item.json.jobId }}",
  "productUrl": "{{ $('Set variables').item.json.productUrl }}"
}
```

### Node 5: IF — Success check
- Condition: `{{ $json.success }}` equals `true`

### Node 6a: HTTP Request — Mark job "done" (true branch)
- Method: `POST`
- URL: `https://haissqtlduybusjzzfsh.supabase.co/functions/v1/update-job`
- Headers: same as Node 3
- Body:
```json
{
  "jobId": "{{ $('Set variables').item.json.jobId }}",
  "status": "done",
  "videoUrls": {{ $json.videoUrls }}
}
```

### Node 6b: HTTP Request — Mark job "failed" (false branch)
- Same as 6a but `"status": "failed"`

---

## Checking logs (when something goes wrong)
Railway → your service → **Deployments** tab → click the latest deploy → **View Logs**

---

## Updating the API key later
Railway → your service → **Variables** tab → click `BOOMLIFY_API_KEY` → edit value → Railway redeploys automatically.
