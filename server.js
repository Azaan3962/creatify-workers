const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
app.use(express.json());

// ── Config (use env vars — never hardcode secrets in production) ──────────────
const BOOMLIFY_API_KEY = process.env.BOOMLIFY_API_KEY || 'api_11db5c08a25e133dac9b1cc5264105c9933c32b4f92fb5a03e3f6d814c7e62e3';
const BOOMLIFY_BASE    = 'https://v1.boomlify.com/api/v1';
const PORT             = process.env.PORT || 3000;

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findEmail(obj, depth = 0) {
  if (depth > 5) return null;
  if (typeof obj === 'string' && obj.includes('@')) return obj;
  if (typeof obj === 'object' && obj !== null) {
    for (const v of Object.values(obj)) {
      const f = findEmail(v, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

function findId(obj, depth = 0) {
  if (depth > 5) return null;
  if (typeof obj === 'object' && obj !== null) {
    for (const k of ['id', 'email_id', 'emailId', 'mailId', 'mail_id']) {
      if (obj[k]) return String(obj[k]);
    }
    for (const v of Object.values(obj)) {
      const f = findId(v, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

// React-compatible value setter — same trick as the Tampermonkey script
async function fillReactInput(page, selector, value) {
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Selector not found: ${sel}`);
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(el, val);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown',  { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup',    { bubbles: true }));
  }, selector, value);
}

// ── Boomlify helpers ──────────────────────────────────────────────────────────

async function createTempEmail() {
  console.log('[worker] Creating temp email via Boomlify...');
  const res = await axios.post(
    `${BOOMLIFY_BASE}/emails/create`,
    {},
    { headers: { 'X-API-Key': BOOMLIFY_API_KEY, 'Content-Type': 'application/json' } }
  );
  const data = res.data;
  console.log('[worker] Boomlify create response:', JSON.stringify(data, null, 2));
  const email = findEmail(data);
  const id    = findId(data);
  if (!email) throw new Error('Could not extract email from Boomlify response');
  if (!id)    throw new Error('Could not extract email ID from Boomlify response');
  console.log('[worker] Temp email:', email, '| ID:', id);
  return { email, id };
}

async function pollForOTP(emailId, maxAttempts = 30) {
  console.log('[worker] Polling Boomlify inbox for OTP, emailId:', emailId);
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(4000);
    console.log(`[worker] OTP poll attempt ${i + 1}/${maxAttempts}...`);
    const res = await axios.get(
      `${BOOMLIFY_BASE}/emails/${emailId}/messages`,
      { headers: { 'X-API-Key': BOOMLIFY_API_KEY } }
    );
    const data = res.data;
    let messages = [];
    if (Array.isArray(data))               messages = data;
    else if (Array.isArray(data.messages)) messages = data.messages;
    else if (Array.isArray(data.data))     messages = data.data;
    else if (typeof data === 'object')
      messages = Object.values(data).find(v => Array.isArray(v)) || [];

    for (const msg of messages) {
      const body = [msg.body, msg.html, msg.text, msg.content, msg.snippet, JSON.stringify(msg)]
        .filter(Boolean).join('\n');
      console.log('[worker] Message subject:', msg.subject || '(none)');
      console.log('[worker] Body preview:', body.substring(0, 200));
      const matches = [...body.matchAll(/\b([0-9]{6})\b/g)];
      if (matches.length > 0) {
        const code = matches[matches.length - 1][1];
        console.log('[worker] OTP found:', code);
        return code;
      }
    }
    console.log('[worker] No OTP yet, waiting...');
  }
  throw new Error('OTP polling timed out after ' + maxAttempts + ' attempts');
}

// ── Main automation route ─────────────────────────────────────────────────────

app.post('/run', async (req, res) => {
  const { productUrl, jobId } = req.body;
  console.log('[worker] /run called — jobId:', jobId, '| productUrl:', productUrl);

  if (!productUrl || !jobId) {
    return res.status(400).json({ success: false, error: 'productUrl and jobId are required' });
  }

  const browser = await puppeteer.launch({
    // Use the system Chromium installed by the Dockerfile
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',   // prevents crashes in Docker's limited /dev/shm
      '--disable-gpu',
      '--window-size=1280,900',
    ],
  });

  try {
    // ── Step 1: Create temp email ─────────────────────────────────────────────
    const { email, id: emailId } = await createTempEmail();

    // ── Step 2: Open Creatify login page ─────────────────────────────────────
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    console.log('[worker] Navigating to Creatify login...');
    await page.goto('https://app.creatify.ai/auth/login', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // ── Step 3: Fill email field ──────────────────────────────────────────────
    await page.waitForSelector('input#email', { timeout: 15000 });
    await fillReactInput(page, 'input#email', email);
    console.log('[worker] Email field filled:', email);

    // ── Step 4: Click "Continue with email" ──────────────────────────────────
    await sleep(800);
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find(b =>
        b.innerText && b.innerText.toLowerCase().includes('continue with email')
      );
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('"Continue with email" button not found');
    console.log('[worker] Clicked "Continue with email"');

    // ── Step 5: Poll Boomlify for OTP (page loads OTP form in parallel) ───────
    const otp = await pollForOTP(emailId);
    console.log('[worker] OTP received:', otp);

    // ── Step 6: Fill OTP into Creatify's code inputs ──────────────────────────
    await page.waitForSelector('input.disabled\\:cursor-not-allowed', { timeout: 20000 });
    await sleep(1000);

    const inputCount = await page.$$eval(
      'input.disabled\\:cursor-not-allowed',
      els => els.length
    );
    console.log('[worker] OTP input count detected:', inputCount);

    if (inputCount === 6) {
      // Individual digit inputs
      const inputHandles = await page.$$('input.disabled\\:cursor-not-allowed');
      for (let i = 0; i < 6; i++) {
        await page.evaluate((el, char) => {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(el, char);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true }));
        }, inputHandles[i], otp[i]);
        await sleep(80);
      }
    } else {
      // Single input for full code
      await fillReactInput(page, 'input.disabled\\:cursor-not-allowed', otp);
      await sleep(500);
      // Click submit/verify
      await page.evaluate(() => {
        const labels = ['verify', 'confirm', 'sign in', 'log in', 'login', 'continue', 'submit'];
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => labels.some(l => (b.innerText || '').toLowerCase().includes(l)));
        if (btn) btn.click();
      });
    }
    console.log('[worker] OTP filled');

    // ── Step 7: Wait for login, go to home ───────────────────────────────────
    await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    await page.goto('https://app.creatify.ai/home', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    console.log('[worker] Logged in successfully, on home page');

    // ── Step 8: Video generation ──────────────────────────────────────────────
    // TODO: Add Creatify video generation steps here.
    // Inspect Creatify's UI to find the selectors, then fill them in below.
    // Example skeleton:
    //
    // await page.waitForSelector('[data-testid="create-video-btn"]', { timeout: 10000 });
    // await page.click('[data-testid="create-video-btn"]');
    // await page.waitForSelector('input[placeholder*="product URL"]', { timeout: 10000 });
    // await fillReactInput(page, 'input[placeholder*="product URL"]', productUrl);
    // await page.click('[data-testid="generate-btn"]');
    //
    // Then wait for video URLs to appear and collect them:
    // await page.waitForSelector('[data-testid="video-result"]', { timeout: 120000 });
    // const videoUrls = await page.$$eval('[data-testid="video-result"] a', els =>
    //   els.map(el => el.href)
    // );

    const videoUrls = []; // Replace with real collection once Step 8 selectors are known

    console.log('[worker] Done — videoUrls:', videoUrls);
    res.json({ success: true, videoUrls, jobId });

  } catch (err) {
    console.error('[worker] ERROR:', err.message);
    res.status(500).json({ success: false, error: err.message, jobId });
  } finally {
    await browser.close();
  }
});

// ── Health check (Cloud Run pings this to confirm container is alive) ─────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`[worker] Puppeteer worker running on port ${PORT}`));
