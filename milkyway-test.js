// milkyway-test.js
// Playwright automation for milkywayapp.xyz:8781
// Handles image CAPTCHA via 2captcha, session persistence, deposit/cashout sync

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// const MW_URL        = 'https://milkywayapp.xyz:8781/default.aspx';
// const MW_USERNAME   = 'lilymilkyy7';
// const MW_PASSWORD   = 'Vegas123';
// const SESSION_FILE  = path.join(__dirname, 'mw-session.json');
// const CAPTCHA_KEY   = process.env.TWOCAPTCHA_KEY || '';   // set in your .env
// const HEADLESS      = process.env.MW_HEADLESS !== 'false'; // set MW_HEADLESS=false to debug visually

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MW_LOGIN_URL = process.env.MW_LOGIN_URL || 'https://milkywayapp.xyz:8781/default.aspx';
const MW_STORE_URL = process.env.MW_STORE_URL || 'https://milkywayapp.xyz:8781/Store.aspx';
const MW_URL = MW_STORE_URL;

const MW_USERNAME = process.env.MW_USERNAME || '';
const MW_PASSWORD = process.env.MW_PASSWORD || '';

const SESSION_FILE = path.join(__dirname, 'mw-session.json');
const CAPTCHA_KEY = process.env.TWOCAPTCHA_KEY || '';
const HEADLESS = process.env.MW_HEADLESS !== 'false';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const CHROME_HEADERS = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'max-age=0',
  'Upgrade-Insecure-Requests': '1',
};

// ─── STATE ───────────────────────────────────────────────────────────────────
let browser   = null;
let context   = null;
let page      = null;
let isReady   = false;   // true once logged in and page is usable

// ─── CAPTCHA SOLVER (2captcha image CAPTCHA) ─────────────────────────────────
/**
 * Sends a base64 image to 2captcha and returns the solved text.
 * Docs: https://2captcha.com/api-docs/normal-captcha
 */
async function solve2captcha(base64Image) {
  if (!CAPTCHA_KEY) throw new Error('TWOCAPTCHA_KEY env var not set');

  // 1. Submit the image
  const submitRes = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      key:    CAPTCHA_KEY,
      method: 'base64',
      body:   base64Image,
      json:   '1',
    }),
  });
  const submitJson = await submitRes.json();
  if (submitJson.status !== 1) throw new Error(`2captcha submit failed: ${submitJson.request}`);

  const captchaId = submitJson.request;

  // 2. Poll for result (up to 60 s, checking every 5 s)
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const pollRes  = await fetch(
      `https://2captcha.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${captchaId}&json=1`
    );
    const pollJson = await pollRes.json();
    if (pollJson.status === 1) return pollJson.request;        // solved text
    if (pollJson.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2captcha poll error: ${pollJson.request}`);
    }
  }
  throw new Error('2captcha timeout — CAPTCHA not solved in 60 s');
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) { console.log(`[MilkyWay] ${new Date().toISOString()} — ${msg}`); }

async function assertNotRuntimeError(response, label = 'MilkyWay page') {
  const status = response?.status();
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');

  if (
    status >= 500 ||
    title.includes('Runtime Error') ||
    bodyText.includes("Server Error in '/' Application")
  ) {
    throw new Error(`${label} returned Runtime Error instead of real page. HTTP ${status}, title: ${title}`);
  }
}

/** Load saved cookies into the browser context */
async function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return false;
    const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    await context.addCookies(cookies);
    log('Session loaded from disk.');
    return true;
  } catch {
    return false;
  }
}

/** Persist current cookies to disk */
async function saveSession() {
  const cookies = await context.cookies();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
  log('Session saved to disk.');
}

/** Returns true if we're already logged in (checks for a post-login element) */
async function checkLoggedIn() {
  try {
    const response = await page.goto(MW_STORE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await assertNotRuntimeError(response, 'MilkyWay store');

    await page.waitForTimeout(2000);

    const loginFields = await page.locator('#txtLoginName, #txtLoginPass, #btnLogin').count();
    if (loginFields > 0) {
      log('Saved session expired — login page detected.');
      return false;
    }

    const pageHasContent = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (pageHasContent && pageHasContent.length > 50) {
      log('Session still valid — skipping login.');
      return true;
    }

    return false;
  } catch (err) {
    log(`checkLoggedIn failed: ${err.message}`);
    return false;
  }
}

/**
 * Perform a fresh login, solving the image CAPTCHA via 2captcha.
 * Retries up to `maxAttempts` times in case of wrong CAPTCHA answer.
 */
async function doLogin(maxAttempts = 3) {
  if (!MW_USERNAME || !MW_PASSWORD) {
    throw new Error('MW_USERNAME/MW_PASSWORD env vars are not set');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Login attempt ${attempt}/${maxAttempts}…`);

    const response = await page.goto(MW_LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await assertNotRuntimeError(response, 'MilkyWay login');

    await page.locator('#txtLoginName').waitFor({ timeout: 20000 });
    await page.locator('#txtLoginPass').waitFor({ timeout: 20000 });
    await page.locator('#txtVerifyCode').waitFor({ timeout: 20000 });
    await page.locator('#ImageCheck').waitFor({ timeout: 20000 });

    await page.fill('#txtLoginName', MW_USERNAME);
    await page.fill('#txtLoginPass', MW_PASSWORD);

    const captchaImg = page.locator('#ImageCheck');
    const captchaBuffer = await captchaImg.screenshot();
    const captchaBase64 = captchaBuffer.toString('base64');

    let captchaText;
    try {
      captchaText = await solve2captcha(captchaBase64);
      captchaText = String(captchaText || '').trim();
      log(`CAPTCHA solved: "${captchaText}"`);
    } catch (err) {
      log(`CAPTCHA solver error: ${err.message}`);
      throw err;
    }

    if (!captchaText) {
      throw new Error('CAPTCHA solver returned empty text');
    }

    await page.fill('#txtVerifyCode', captchaText);

    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}),
      page.click('#btnLogin'),
    ]);

    await page.waitForTimeout(3000);

    const stillOnLogin = await page.locator('#txtLoginName, #txtLoginPass, #btnLogin').count();

    if (stillOnLogin === 0) {
      log('Login successful.');
      await saveSession();
      return true;
    }

    const bodyText = await page.locator('body').innerText().catch(() => '');
    log(`Login failed attempt ${attempt}. Page text preview: ${bodyText.slice(0, 300)}`);

    try {
      await page.locator('#ImageCheck').click({ timeout: 3000 });
      await page.waitForTimeout(1000);
    } catch {
      // ignore captcha refresh failure
    }
  }

  throw new Error(`Login failed after ${maxAttempts} attempts`);
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * warmMilkywaySession()
 * Call once on server start. Launches browser, tries saved cookies, logs in if needed.
 */
export async function warmMilkywaySession() {
  log('Warming session…');

  try {
    if (browser) {
      await browser.close().catch(() => {});
    }

    browser = await chromium.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    context = await browser.newContext({
      userAgent: CHROME_UA,
      ignoreHTTPSErrors: true,
      locale: 'en-US',
      viewport: { width: 1365, height: 768 },
      extraHTTPHeaders: CHROME_HEADERS,
    });

    page = await context.newPage();

    const loaded = await loadSession();
    if (loaded) {
      const valid = await checkLoggedIn();
      if (valid) {
        isReady = true;
        return;
      }

      log('Saved session expired — doing fresh login.');
    }

    await doLogin();
    isReady = true;
    log('Session warmed and ready.');
  } catch (err) {
    log(`warmMilkywaySession error: ${err.message}`);
    isReady = false;
    throw err;
  }
}

/**
 * startMilkywayKeepAlive()
 * Pings the site every 20 min so the session doesn't expire.
 * Call once after warmMilkywaySession() resolves.
 */
export function startMilkywayKeepAlive() {
  const INTERVAL_MS = 20 * 60 * 1000;

  setInterval(async () => {
    if (!page) return;

    try {
      log('Keep-alive ping…');

      const response = await page.goto(MW_STORE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await assertNotRuntimeError(response, 'MilkyWay keep-alive');

      const onLoginPage = await page.locator('#txtLoginName, #txtLoginPass, #btnLogin').count();

      if (onLoginPage > 0) {
        log('Keep-alive: session expired — re-logging in.');
        isReady = false;
        await doLogin();
        isReady = true;
      } else {
        log('Keep-alive: session OK.');
      }
    } catch (err) {
      log(`Keep-alive error: ${err.message}`);
      isReady = false;
    }
  }, INTERVAL_MS);

  log('Keep-alive started (every 20 min).');
}

/**
 * ensureReady()
 * Internal guard — re-warms session if browser crashed or was never started.
 */
async function ensureReady() {
  if (!browser || !page || !isReady) {
    log('Session not ready — re-warming…');
    await warmMilkywaySession();
  }
}

/**
 * syncCreatePlayer(username)
 * Searches for the player on MilkyWay to verify they exist.
 * MilkyWay auto-creates players on first search in most configurations,
 * but this at minimum confirms the account is reachable.
 */
export async function syncCreatePlayer(username) {
  try {
    await ensureReady();
    log(`syncCreatePlayer: ${username}`);
    await searchPlayer(username);
    log(`syncCreatePlayer OK: ${username}`);
    return { ok: true };
  } catch (err) {
    log(`syncCreatePlayer error: ${err.message}`);
    isReady = false;
    return { ok: false, error: err.message };
  }
}

/**
 * syncDeposit(username, amount)
 * Search player → Update → Recharge → enter amount → confirm.
 */
export async function syncDeposit(username, amount) {
  try {
    await ensureReady();
    log(`syncDeposit: ${username} $${amount}`);

    await searchPlayer(username);
    await clickUpdate();
    await clickRecharge();
    await enterAmount(amount);
    await confirmAction();

    log(`syncDeposit OK: ${username} $${amount}`);
    return { ok: true };
  } catch (err) {
    log(`syncDeposit error (${username} $${amount}): ${err.message}`);
    isReady = false;
    return { ok: false, error: err.message };
  }
}

/**
 * syncCashout(username, amount)
 * Search player → Update → Redeem → enter amount → confirm.
 */
export async function syncCashout(username, amount) {
  try {
    await ensureReady();
    log(`syncCashout: ${username} $${amount}`);

    await searchPlayer(username);
    await clickUpdate();
    await clickRedeem();
    await enterAmount(amount);
    await confirmAction();

    log(`syncCashout OK: ${username} $${amount}`);
    return { ok: true };
  } catch (err) {
    log(`syncCashout error (${username} $${amount}): ${err.message}`);
    isReady = false;
    return { ok: false, error: err.message };
  }
}

// ─── PAGE ACTION HELPERS ──────────────────────────────────────────────────────
// ⚠️  The selectors below are BEST-GUESS from the login CSS structure.
//     Run with MW_HEADLESS=false once to visually confirm each step,
//     then replace any wrong selectors.

/**
 * Navigate to home and search for a player by username.
 */
async function searchPlayer(username) {
  // Go to main page if not already there
  const url = page.url();
  if (!url.startsWith(MW_URL) || url.includes('login') || url.includes('Login')) {
    await page.goto(MW_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  }

  // ── Search box ─────────────────────────────────────────────────────────────
  // Common selectors on MilkyWay management panels — adjust as needed:
  const SEARCH_SELECTOR = [
    'input[placeholder*="username" i]',
    'input[placeholder*="search" i]',
    'input[placeholder*="player" i]',
    'input[name="username"]',
    'input[name="search"]',
    '#searchInput',
    '.search-input input',
  ].join(', ');

  const searchBox = await page.waitForSelector(SEARCH_SELECTOR, { timeout: 10000 });
  await searchBox.fill('');
  await searchBox.type(username, { delay: 60 });

  // ── Submit search ──────────────────────────────────────────────────────────
  // Try pressing Enter first; if the site has a search button, click it instead
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  // Verify a result row appeared
  const resultRow = await page.$(
    `tr:has-text("${username}"), .player-row:has-text("${username}"), td:has-text("${username}")`
  );
  if (!resultRow) throw new Error(`Player "${username}" not found in search results`);
}

/**
 * Click the "Update" button that appears next to the player row.
 */
async function clickUpdate() {
  const UPDATE_SELECTOR = [
    'button:has-text("Update")',
    'a:has-text("Update")',
    'input[value="Update"]',
    '.btn-update',
    'td button',          // fallback: first button in result row
  ].join(', ');

  const btn = await page.waitForSelector(UPDATE_SELECTOR, { timeout: 8000 });
  await btn.click();
  await page.waitForTimeout(1000);
}

/**
 * Click "Recharge" in the Update modal/panel.
 */
async function clickRecharge() {
  const RECHARGE_SELECTOR = [
    'button:has-text("Recharge")',
    'a:has-text("Recharge")',
    'input[value="Recharge"]',
    'label:has-text("Recharge")',
    'option[value*="recharge" i]',
    '.btn-recharge',
  ].join(', ');

  const btn = await page.waitForSelector(RECHARGE_SELECTOR, { timeout: 8000 });
  await btn.click();
  await page.waitForTimeout(800);
}

/**
 * Click "Redeem" in the Update modal/panel.
 */
async function clickRedeem() {
  const REDEEM_SELECTOR = [
    'button:has-text("Redeem")',
    'a:has-text("Redeem")',
    'input[value="Redeem"]',
    'label:has-text("Redeem")',
    'option[value*="redeem" i]',
    '.btn-redeem',
  ].join(', ');

  const btn = await page.waitForSelector(REDEEM_SELECTOR, { timeout: 8000 });
  await btn.click();
  await page.waitForTimeout(800);
}

/**
 * Enter the dollar amount in the amount field.
 */
async function enterAmount(amount) {
  const AMOUNT_SELECTOR = [
    'input[name="amount"]',
    'input[placeholder*="amount" i]',
    'input[placeholder*="credit" i]',
    'input[type="number"]',
    '.amount-input',
  ].join(', ');

  const amountField = await page.waitForSelector(AMOUNT_SELECTOR, { timeout: 8000 });
  await amountField.fill('');
  await amountField.type(String(amount), { delay: 50 });
}

/**
 * Click the final confirm/submit button.
 */
async function confirmAction() {
  const CONFIRM_SELECTOR = [
    'button:has-text("Confirm")',
    'button:has-text("Submit")',
    'button:has-text("OK")',
    'input[value="Confirm"]',
    'input[value="Submit"]',
    '.btn-confirm',
    '.btn-submit',
  ].join(', ');

  const btn = await page.waitForSelector(CONFIRM_SELECTOR, { timeout: 8000 });
  await btn.click();
  await page.waitForTimeout(1500);

  // Optional: check for a success toast/message
  try {
    await page.waitForSelector(
      '.success, .alert-success, :has-text("success"), :has-text("Success")',
      { timeout: 5000 }
    );
    log('Confirmation success message detected.');
  } catch {
    // No explicit success message — proceed anyway
    log('No success toast detected (may still have worked).');
  }
}

// ADD at the bottom of milkyway-test.js

/**
 * syncDepositById(remoteId, amount)
 * Uses the player's MilkyWay account ID (remoteAccountId from GameAccount table)
 * instead of the OceanBets username.
 */
export async function syncDepositById(remoteId, amount) {
  try {
    await ensureReady();
    log(`syncDepositById: remoteId="${remoteId}" $${amount}`);
    await searchPlayer(remoteId);    // searchPlayer already accepts any string
    await clickUpdate();
    await clickRecharge();
    await enterAmount(amount);
    await confirmAction();
    log(`syncDepositById OK: "${remoteId}" +$${amount}`);
    return { ok: true };
  } catch (err) {
    log(`syncDepositById error (${remoteId} $${amount}): ${err.message}`);
    isReady = false;
    return { ok: false, error: err.message };
  }
}

/**
 * syncCashoutById(remoteId, amount)
 */
export async function syncCashoutById(remoteId, amount) {
  try {
    await ensureReady();
    log(`syncCashoutById: remoteId="${remoteId}" $${amount}`);
    await searchPlayer(remoteId);
    await clickUpdate();
    await clickRedeem();
    await enterAmount(amount);
    await confirmAction();
    log(`syncCashoutById OK: "${remoteId}" -$${amount}`);
    return { ok: true };
  } catch (err) {
    log(`syncCashoutById error (${remoteId} $${amount}): ${err.message}`);
    isReady = false;
    return { ok: false, error: err.message };
  }
}
