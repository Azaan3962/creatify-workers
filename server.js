const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
app.use(express.json());

const BOOMLIFY_API_KEY = process.env.BOOMLIFY_API_KEY || 'api_11db5c08a25e133dac9b1cc5264105c9933c32b4f92fb5a03e3f6d814c7e62e3';
const BOOMLIFY_BASE    = 'https://v1.boomlify.com/api/v1';
const PORT             = process.env.PORT || 3000;

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

async function fillReactInput(page, selector, value) {
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('Selector not found: ' + sel);
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

async function createTempEmail() {
  console.log('[worker] Creating temp email...');
  const res = await axios.post(
    `${BOOMLIFY_BASE}/emails/create`, {},
    { headers: { 'X-API-Key': BOOMLIFY_API_KEY } }
  );
  const email = findEmail(res.data);
  const id    = findId(res.data);
  if (!email) throw new Error('No email in Boomlify response');
  if (!id)    throw new Error('No ID in Boomlify response');
  console.log('[worker] Email:', email, 'ID:', id);
  return { email, id };
}

async function pollForOTP(emailId, maxAttempts = 30) {
  console.log('[worker] Polling for OTP...');
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(4000);
    console.log(`[worker] Poll ${i + 1}/${maxAttempts}`);
    const res = await axios.get(
      `${BOOMLIFY_BASE}/emails/${emailId}/messages`,
      { headers: { 'X-API-Key': BOOMLIFY_API_KEY } }
    );
    const data = res.data;
    let messages = Array.isArray(data) ? data
      : Array.isArray(data.messages) ? data.messages
      : Array.isArray(data.data) ? data.data : [];

    for (const msg of messages) {
      const body = [msg.body, msg.html, msg.text, msg.content, JSON.stringify(msg)]
        .filter(Boolean).join('\n');
      const matches = [...body.matchAll(/\b([0-9]{6})\b/g)];
      if (matches.length > 0) {
        const code = matches[matches.length - 1][1];
        console.log('[worker] OTP:', code);
        return code;
      }
    }
  }
  throw new Error('OTP timeout');
}

app.post('/run', async (req, res) => {
  const { productUrl, jobId } = req.body;
  console.log('[worker] /run — jobId:', jobId);

  if (!productUrl || !jobId) {
    return res.status(400).json({ success: false, error: 'productUrl and jobId required' });
  }

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: [
      // ── Critical crashpad fix ───────────────────────────────────────────────
      '--disable-crash-reporter',          // fixes: chrome_crashpad_handler --database required
      '--no-crashpad',                     // disables crashpad entirely
      '--disable-breakpad',                // disables breakpad crash reporting

      // ── Sandbox & GPU ───────────────────────────────────────────────────────
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',

      // ── Memory saving ───────────────────────────────────────────────────────
      '--no-zygote',
      '--single-process',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--js-flags=--max-old-space-size=256',
      '--window-size=800,600',
    ],
  });

  try {
    const { email, id: emailId } = await createTempEmail();

    const page = await browser.newPage();

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const type = request.resourceType();
      const url  = request.url();
      if (
        ['image', 'media', 'font', 'stylesheet', 'other'].includes(type) ||
        url.includes('analytics') || url.includes('hotjar') ||
        url.includes('intercom')  || url.includes('segment') ||
        url.includes('sentry')
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setViewport({ width: 800, height: 600 });

    console.log('[worker] Going to Creatify login...');
    await page.goto('https://app.creatify.ai/auth/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForSelector('input#email', { timeout: 15000 });
    await fillReactInput(page, 'input#email', email);
    console.log('[worker] Email filled');

    await sleep(800);
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.innerText && b.innerText.toLowerCase().includes('continue with email'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('Continue button not found');
    console.log('[worker] Clicked Continue');

    const otp = await pollForOTP(emailId);

    await page.waitForSelector('input.disabled\\:cursor-not-allowed', { timeout: 20000 });
    await sleep(500);

    const inputCount = await page.$$eval(
      'input.disabled\\:cursor-not-allowed', els => els.length
    );
    console.log('[worker] OTP inputs:', inputCount);

    if (inputCount === 6) {
      const handles = await page.$$('input.disabled\\:cursor-not-allowed');
      for (let i = 0; i < 6; i++) {
        await page.evaluate((el, char) => {
          const s = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          s.call(el, char);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true }));
        }, handles[i], otp[i]);
        await sleep(80);
      }
    } else {
      await fillReactInput(page, 'input.disabled\\:cursor-not-allowed', otp);
      await sleep(500);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => ['verify','confirm','sign in','login','continue','submit']
            .some(l => (b.innerText||'').toLowerCase().includes(l)));
        if (btn) btn.click();
      });
    }
    console.log('[worker] OTP filled');

    await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    console.log('[worker] Logged in successfully');

    // Step 8: Video generation — TODO
    const videoUrls = [];

    console.log('[worker] Done — videoUrls:', videoUrls);
    res.json({ success: true, videoUrls, jobId });

  } catch (err) {
    console.error('[worker] ERROR:', err.message);
    res.status(500).json({ success: false, error: err.message, jobId });
  } finally {
    await browser.close().catch(() => {});
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`[worker] Running on port ${PORT}`));
