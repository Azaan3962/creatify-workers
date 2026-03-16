# Creatify Puppeteer Worker — Deployment Guide

## Files in this folder
```
creatify-worker/
├── server.js        ← The automation server
├── Dockerfile       ← Cloud Run container definition
├── package.json     ← Node dependencies
├── .dockerignore    ← Keeps image small
└── .gitignore       ← Never commit secrets
```

---

## Deploy to Google Cloud Run (step by step)

### Prerequisites
- Google Cloud account (free tier works)
- [Install Google Cloud CLI](https://cloud.google.com/sdk/docs/install)

---

### Step 1 — One-time setup

```bash
# Login
gcloud auth login

# Create a new project (or use existing)
gcloud projects create creatify-worker-proj --name="Creatify Worker"
gcloud config set project creatify-worker-proj

# Enable required services
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
```

---

### Step 2 — Deploy

Run this from inside the `creatify-worker/` folder:

```bash
gcloud run deploy creatify-worker \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 1 \
  --timeout 300 \
  --set-env-vars BOOMLIFY_API_KEY=api_11db5c08a25e133dac9b1cc5264105c9933c32b4f92fb5a03e3f6d814c7e62e3
```

> **`--timeout 300`** = 5 minutes. Increase to `--timeout 600` if video generation takes longer.
> **`--memory 2Gi`** is required — Chrome crashes with less.

When it finishes, you'll get a URL like:
```
https://creatify-worker-abc123-uc.a.run.app
```

---

### Step 3 — Test it

```bash
curl -X POST https://YOUR-WORKER-URL.a.run.app/run \
  -H "Content-Type: application/json" \
  -d '{"productUrl":"https://example.com","jobId":"test-001"}'
```

You should get:
```json
{"success": true, "videoUrls": [], "jobId": "test-001"}
```

Health check:
```bash
curl https://YOUR-WORKER-URL.a.run.app/health
# → {"status":"ok"}
```

---

## n8n Workflow — 7 nodes

### Node 1: Webhook
- Type: `Webhook`  
- Method: `POST`  
- Path: `generate-video`  
- Response: `Using 'Respond to Webhook' Node`

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
- URL: `https://YOUR-WORKER-URL.a.run.app/run`
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

## Updating the API key later

```bash
gcloud run services update creatify-worker \
  --region us-central1 \
  --set-env-vars BOOMLIFY_API_KEY=NEW_KEY_HERE
```

---

## Checking logs (when something goes wrong)

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=creatify-worker" \
  --limit 50 \
  --format "table(timestamp, textPayload)"
```

Or open Cloud Console → Cloud Run → creatify-worker → Logs tab.
