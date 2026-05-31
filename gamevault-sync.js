// gamevault-sync.js
// Playwright automation for agent.gamevault999.com

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GV_LOGIN_URL = process.env.GV_LOGIN_URL || 'https://agent.gamevault999.com/login';
const GV_USERNAME  = process.env.GV_USERNAME  || '';
const GV_PASSWORD  = process.env.GV_PASSWORD  || '';
const SESSION_FILE = path.join(__dirname, 'gv-session.json');
const HEADLESS     = process.env.MW_HEADLESS !== 'false';

let browser = null, context = null, page = null, isReady = false;

function log(msg) { console.log(`[GameVault] ${new Date().toISOString()} — ${msg}`); }

async function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return false;
    await context.addCookies(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')));
    return true;
  } catch { return false; }
}
async function saveSession() {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(await context.cookies(), null, 2));
}

async function checkLoggedIn() {
  try {
    const res = await page.goto('https://agent.gamevault999.com/dashboard', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await page.waitForTimeout(2000);
    const loginCount = await page.locator('input[type="password"]').count();
    return loginCount === 0;
  } catch { return false; }
}

async function doLogin() {
  if (!GV_USERNAME || !GV_PASSWORD) throw new Error('GV_USERNAME/GV_PASSWORD not set in .env');
  log('Logging in to GameVault…');
  await page.goto(GV_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // ⚠️ Confirm selectors by running with HEADLESS=false
  await page.fill('input[name="username"], input[placeholder*="username" i], input[type="text"]', GV_USERNAME);
  await page.fill('input[name="password"], input[type="password"]', GV_PASSWORD);
  await page.click('button[type="submit"], .login-btn');
  await page.waitForTimeout(3000);
  await saveSession();
  log('Login successful.');
}

export async function warmGameVaultSession() {
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  context = await browser.newContext({ ignoreHTTPSErrors: true });
  page = await context.newPage();
  const loaded = await loadSession();
  if (loaded && await checkLoggedIn()) { isReady = true; return; }
  await doLogin();
  isReady = true;
}

export function startGameVaultKeepAlive() {
  setInterval(async () => {
    if (!page) return;
    try {
      const ok = await checkLoggedIn();
      if (!ok) { isReady = false; await doLogin(); isReady = true; }
    } catch (err) { log(`Keep-alive error: ${err.message}`); isReady = false; }
  }, 20 * 60 * 1000);
}

async function ensureReady() {
  if (!browser || !page || !isReady) await warmGameVaultSession();
}

async function performAction(remoteId, amount, action) {
  // Navigate to member/player management
  await page.goto('https://agent.gamevault999.com/members', {
    waitUntil: 'domcontentloaded', timeout: 30000
  }).catch(() => {});
  await page.waitForTimeout(1500);

  // Search by remoteId
  const searchBox = await page.waitForSelector(
    'input[placeholder*="search" i], input[name="search"], input[placeholder*="username" i]',
    { timeout: 10000 }
  );
  await searchBox.fill(remoteId);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  const row = await page.$(`tr:has-text("${remoteId}"), td:has-text("${remoteId}")`);
  if (!row) throw new Error(`Player "${remoteId}" not found in GameVault`);
  await row.click();
  await page.waitForTimeout(800);

  if (action === 'credit') {
    await page.click('button:has-text("Add Credits"), button:has-text("Recharge"), .btn-credit');
  } else {
    await page.click('button:has-text("Deduct"), button:has-text("Redeem"), .btn-debit');
  }
  await page.waitForTimeout(500);

  const amountField = await page.waitForSelector(
    'input[name="amount"], input[type="number"], input[placeholder*="amount" i]',
    { timeout: 8000 }
  );
  await amountField.fill(String(amount));
  await page.click('button:has-text("Confirm"), button:has-text("Submit"), .btn-confirm');
  await page.waitForTimeout(1500);
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
