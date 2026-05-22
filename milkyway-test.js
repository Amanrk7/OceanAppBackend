// milkyway-test.js
// Playwright automation for milkywayapp.xyz:8781
// Handles image CAPTCHA via 2captcha, session persistence, deposit/cashout sync

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MW_URL        = 'http://milkywayapp.xyz:8781';
const MW_USERNAME   = 'lilymilkyy7';
const MW_PASSWORD   = 'Vegas123';
const SESSION_FILE  = path.join(__dirname, 'mw-session.json');
const CAPTCHA_KEY   = process.env.TWOCAPTCHA_KEY || '';   // set in your .env
const HEADLESS      = process.env.MW_HEADLESS !== 'false'; // set MW_HEADLESS=false to debug visually

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
    await page.goto(MW_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // After login, MilkyWay shows a search / management UI — NOT the login form.
    // Adjust this selector once you've observed the logged-in page.
    const loggedInEl = await page.$('input[type="text"][placeholder], .search-box, #searchInput, .main-content');
    if (loggedInEl) {
      log('Session still valid — skipping login.');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Perform a fresh login, solving the image CAPTCHA via 2captcha.
 * Retries up to `maxAttempts` times in case of wrong CAPTCHA answer.
 */
async function doLogin(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Login attempt ${attempt}/${maxAttempts}…`);

    await page.goto(MW_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // ── Fill username ──────────────────────────────────────────────────────
    // The first .login-input-box input is username
    const inputs = await page.$$('.login-input-box input');
    if (inputs.length < 2) throw new Error('Could not find username/password fields');
    await inputs[0].fill(MW_USERNAME);
    await inputs[1].fill(MW_PASSWORD);

    // ── Solve CAPTCHA ──────────────────────────────────────────────────────
    // The CAPTCHA image is rendered by VerifyImagePage.aspx
    // It appears as an <img> inside .login-input-box-code
    const captchaImg = await page.$('.login-input-box-code img');
    if (!captchaImg) throw new Error('CAPTCHA image element not found');

    // Screenshot just the CAPTCHA image element → base64
    const captchaBuffer = await captchaImg.screenshot();
    const captchaBase64 = captchaBuffer.toString('base64');

    let captchaText;
    try {
      captchaText = await solve2captcha(captchaBase64);
      log(`CAPTCHA solved: "${captchaText}"`);
    } catch (err) {
      log(`CAPTCHA solver error: ${err.message}`);
      throw err;
    }

    // ── Enter CAPTCHA code ─────────────────────────────────────────────────
    const codeInput = await page.$('.login-input-box-code input');
    if (!codeInput) throw new Error('CAPTCHA input field not found');
    await codeInput.fill(captchaText);

    // ── Click login ────────────────────────────────────────────────────────
    await page.click('.login-button-box');
    await page.waitForTimeout(2000);

    // ── Check result ───────────────────────────────────────────────────────
    const stillOnLogin = await page.$('.login-button-box');
    if (!stillOnLogin) {
      log('Login successful.');
      await saveSession();
      return true;
    }

    log(`Login failed (attempt ${attempt}) — wrong CAPTCHA or credentials?`);
    // Loop: the page will show a fresh CAPTCHA on reload
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
    browser = await chromium.launch({ headless: HEADLESS });
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    page = await context.newPage();

    const loaded = await loadSession();
    if (loaded) {
      const valid = await checkLoggedIn();
      if (valid) { isReady = true; return; }
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
  const INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
  setInterval(async () => {
    if (!page) return;
    try {
      log('Keep-alive ping…');
      await page.goto(MW_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
      const stillIn = !(await page.$('.login-button-box'));
      if (!stillIn) {
        log('Keep-alive: session expired — re-logging in.');
        isReady = false;
        await doLogin();
        isReady = true;
      } else {
        log('Keep-alive: session OK.');
      }
    } catch (err) {
      log(`Keep-alive error: ${err.message}`);
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
