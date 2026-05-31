// riversweep-sync.js
// Playwright automation for river-pay.com agent portal
// Handles deposit (Add Credits) and cashout (Deduct Credits) sync

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RS_LOGIN_URL = process.env.RS_LOGIN_URL || 'https://river-pay.com/office/login';
const RS_USERNAME  = process.env.RS_USERNAME  || '';
const RS_PASSWORD  = process.env.RS_PASSWORD  || '';
const SESSION_FILE = path.join(__dirname, 'rs-session.json');
const HEADLESS     = process.env.MW_HEADLESS !== 'false';

let browser = null, context = null, page = null, isReady = false;

function log(msg) { console.log(`[RiverSweep] ${new Date().toISOString()} — ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return false;
    await context.addCookies(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')));
    log('Session loaded from disk.');
    return true;
  } catch { return false; }
}

async function saveSession() {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(await context.cookies(), null, 2));
  log('Session saved.');
}

async function checkLoggedIn() {
  try {
    // Try navigating to a page that only shows when logged in
    const res = await page.goto('https://river-pay.com/office/dashboard', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(2000);
    // If we see a login form, we're NOT logged in
    const loginCount = await page.locator('input[type="password"], [name="password"]').count();
    if (loginCount > 0) { log('Session expired.'); return false; }
    log('Session still valid.'); return true;
  } catch { return false; }
}

async function doLogin() {
  if (!RS_USERNAME || !RS_PASSWORD) throw new Error('RS_USERNAME/RS_PASSWORD not set in .env');
  log('Logging in to RiverSweep…');
  await page.goto(RS_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // ⚠️ Run with HEADLESS=false first to confirm these selectors match the actual UI
  await page.fill('input[name="username"], input[id="username"], input[type="text"]:first-of-type', RS_USERNAME);
  await page.fill('input[name="password"], input[id="password"], input[type="password"]', RS_PASSWORD);
  await page.click('button[type="submit"], .login-btn, input[value="Login"], input[value="Sign In"]');
  await page.waitForTimeout(3000);
  await saveSession();
  log('Login successful.');
}

export async function warmRiverSweepSession() {
  log('Warming session…');
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  page = await context.newPage();
  const loaded = await loadSession();
  if (loaded && await checkLoggedIn()) { isReady = true; return; }
  await doLogin();
  isReady = true;
  log('Session ready.');
}

export function startRiverSweepKeepAlive() {
  setInterval(async () => {
    if (!page) return;
    try {
      const ok = await checkLoggedIn();
      if (!ok) { isReady = false; await doLogin(); isReady = true; }
      else log('Keep-alive: session OK.');
    } catch (err) { log(`Keep-alive error: ${err.message}`); isReady = false; }
  }, 20 * 60 * 1000);
  log('Keep-alive started.');
}

async function ensureReady() {
  if (!browser || !page || !isReady) await warmRiverSweepSession();
}

// ─── Core action: find player and credit/debit ────────────────────────────────
// ⚠️ IMPORTANT: These selectors are placeholders.
// Run with MW_HEADLESS=false, log in manually, inspect the DOM, then update them.
async function performAction(remoteId, amount, action /* 'credit' | 'debit' */) {
  // Step 1: Navigate to user/player list
  await page.goto('https://river-pay.com/office/members', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }).catch(() => page.goto('https://river-pay.com/office/users', { waitUntil: 'domcontentloaded', timeout: 30000 }));
  await page.waitForTimeout(1500);

  // Step 2: Search for the player by their remoteId
  const searchBox = await page.waitForSelector(
    'input[placeholder*="search" i], input[placeholder*="username" i], input[name="q"], .search-input input',
    { timeout: 10000 }
  );
  await searchBox.fill('');
  await searchBox.type(remoteId, { delay: 50 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  // Step 3: Click the player row
  const row = await page.$(
    `tr:has-text("${remoteId}"), .player-row:has-text("${remoteId}"), td:has-text("${remoteId}")`
  );
  if (!row) throw new Error(`Player "${remoteId}" not found in RiverSweep`);
  await row.click();
  await page.waitForTimeout(800);

  // Step 4: Click Credit or Debit
  if (action === 'credit') {
    await page.click([
      'button:has-text("Add Credits")', 'button:has-text("Recharge")',
      'button:has-text("Deposit")', 'a:has-text("Add Credits")',
      '.btn-add', '.btn-credit',
    ].join(', '));
  } else {
    await page.click([
      'button:has-text("Deduct")', 'button:has-text("Redeem")',
      'button:has-text("Remove Credits")', 'a:has-text("Deduct")',
      '.btn-deduct', '.btn-debit',
    ].join(', '));
  }
  await page.waitForTimeout(500);

  // Step 5: Enter the amount
  const amountField = await page.waitForSelector(
    'input[name="amount"], input[placeholder*="amount" i], input[type="number"]',
    { timeout: 8000 }
  );
  await amountField.fill('');
  await amountField.type(String(amount), { delay: 50 });

  // Step 6: Confirm
  await page.click([
    'button:has-text("Confirm")', 'button:has-text("Submit")',
    'button:has-text("OK")', 'input[value="Confirm"]',
    '.btn-confirm', '.btn-submit',
  ].join(', '));
  await page.waitForTimeout(1500);
  log(`${action} $${amount} for "${remoteId}" done.`);
}

export async function syncDeposit(remoteId, amount) {
  try {
    await ensureReady();
    log(`syncDeposit: "${remoteId}" +$${amount}`);
    await performAction(remoteId, amount, 'credit');
    return { ok: true };
  } catch (err) {
    log(`syncDeposit error: ${err.message}`);
    isReady = false;
    return { ok: false, error: err.message };
  }
}

export async function syncCashout(remoteId, amount) {
  try {
    await ensureReady();
    log(`syncCashout: "${remoteId}" -$${amount}`);
    await performAction(remoteId, amount, 'debit');
    return { ok: true };
  } catch (err) {
    log(`syncCashout error: ${err.message}`);
    isReady = false;
    return { ok: false, error: err.message };
  }
}
