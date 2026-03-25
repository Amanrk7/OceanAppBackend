/**
 * milkyway-sync.js
 * ─────────────────────────────────────────────────────────────
 * Keeps a persistent Playwright session to MilkyWay.
 * Re-logs in automatically if the session expires.
 *
 * Usage (from index.js):
 *   import { syncCreatePlayer } from './milkyway-sync.js';
 *   const result = await syncCreatePlayer(username, password);
 *   // result: { ok: true } | { ok: false, error: string }
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import Jimp from 'jimp';
import Tesseract from 'tesseract.js';

// ─── Config ───────────────────────────────────────────────────
const MW_HOST = process.env.MW_HOST || 'https://milkywayapp.xyz:8781';
const MW_USER = process.env.MW_USER;
const MW_PASS = process.env.MW_PASS;
const OUTPUT = './mw-output';
const HEADLESS = true;

if (!MW_USER || !MW_PASS) {
    console.warn('⚠️  MW_USER / MW_PASS not set — MilkyWay sync is disabled');
}

if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

// ─── Singleton browser / page ─────────────────────────────────
let browser = null;
let mwPage = null;
let loggedIn = false;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
            headless: HEADLESS,
            args: ['--ignore-certificate-errors', '--disable-web-security', '--no-sandbox'],
        });
        mwPage = null;
        loggedIn = false;
    }
    if (!mwPage || mwPage.isClosed()) {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        mwPage = await ctx.newPage();
        await mwPage.setViewportSize({ width: 1280, height: 900 });
        loggedIn = false;
    }
    return mwPage;
}

// ─── CAPTCHA solver ───────────────────────────────────────────
async function solveCaptcha(page) {
    const captchaPath = path.join(OUTPUT, 'captcha-raw.png');

    const selectors = [
        'img[src*="aptcha"]', 'img[id*="aptcha"]',
        'img[id*="Image"]', 'img[src*="Verify"]',
        'img[src*="verify"]', 'img[src*="code"]',
    ];
    let captchaEl = null;
    for (const sel of selectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) { captchaEl = el; break; }
    }
    if (!captchaEl) captchaEl = page.locator('img').last();

    await captchaEl.waitFor({ state: 'visible', timeout: 10_000 });

    let imageBuffer;
    try {
        const imgSrc = await captchaEl.evaluate(el => el.src);
        const resp = await page.context().request.get(imgSrc);
        imageBuffer = await resp.body();
        fs.writeFileSync(captchaPath, imageBuffer);
    } catch {
        await captchaEl.screenshot({ path: captchaPath });
        imageBuffer = fs.readFileSync(captchaPath);
    }

    if (imageBuffer.length < 500) return '';

    const pipelines = [
        { name: 'gs-maxc-4x', fn: img => img.greyscale().contrast(1).scale(4) },
        { name: 'gs-c0.5-4x', fn: img => img.greyscale().contrast(0.5).scale(4) },
        { name: 'inv-gs-4x', fn: img => img.invert().greyscale().contrast(1).scale(4) },
        { name: 'gs-norm-4x', fn: img => img.greyscale().normalize().scale(4) },
    ];

    let bestCode = '', bestConf = 0;
    for (const p of pipelines) {
        try {
            const out = path.join(OUTPUT, `cap-${p.name}.png`);
            const img = await Jimp.read(captchaPath);
            p.fn(img);
            await img.writeAsync(out);
            const res = await Tesseract.recognize(out, 'eng', {
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                tessedit_pageseg_mode: '7',
            });
            const conf = res.data.confidence || 0;
            const code = res.data.text.replace(/[^A-Za-z0-9]/g, '').trim();
            if (conf > bestConf && code.length >= 3) { bestConf = conf; bestCode = code; }
        } catch { /* skip */ }
    }
    return bestCode;
}

// ─── Login ───────────────────────────────────────────────────
async function login(page) {
    console.log('🔐 [MW Sync] Logging in to MilkyWay...');
    try {
        await page.goto(`${MW_HOST}/default.aspx`, { waitUntil: 'load', timeout: 45_000 });
    } catch {
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
    }

    if (!page.url().toLowerCase().includes('default.aspx')) {
        loggedIn = true;
        console.log('✅ [MW Sync] Already logged in.');
        return;
    }

    for (let attempt = 1; attempt <= 8; attempt++) {
        await page.locator('input[placeholder="Enter your username"]')
            .waitFor({ state: 'visible', timeout: 10_000 });

        await page.locator('input[placeholder="Enter your username"]').fill(MW_USER);
        await page.locator('input[placeholder="Enter your password"]').fill(MW_PASS);

        const captchaCode = await solveCaptcha(page);
        if (!captchaCode) {
            await page.reload({ waitUntil: 'load' });
            continue;
        }

        await page.locator('input[placeholder="Code"]').fill(captchaCode);
        await page.locator('button:has-text("Login in"), input[value="Login in"]').first().click();

        try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); }
        catch { await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }); }

        if (!page.url().toLowerCase().includes('default.aspx')) {
            loggedIn = true;
            console.log('✅ [MW Sync] Login successful!');
            return;
        }

        await page.reload({ waitUntil: 'load' });
    }
    throw new Error('MilkyWay login failed after 8 attempts');
}

// ─── Navigate to User Management (AccountsList iframe) ────────
async function goToUserManagement(page) {
    // Click "User Management" in the Left.aspx sidebar frame
    const leftFrame = page.frames().find(f => f.url().includes('Left.aspx'));
    const target = leftFrame ?? page.mainFrame();

    const navSelectors = [
        'a:has-text("User Management")',
        'span:has-text("User Management")',
        'li:has-text("User Management")',
    ];
    for (const sel of navSelectors) {
        const el = target.locator(sel).first();
        if (await el.count() > 0) { await el.click(); break; }
    }

    try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); }
    catch { await page.waitForTimeout(2000); }

    // Some builds show "Player" sub-item after expanding the menu
    for (const frame of page.frames()) {
        for (const sel of ['a:has-text("Player List")', 'a:has-text("Players")', 'a:has-text("Player")']) {
            const el = frame.locator(sel).first();
            if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                await el.click();
                try { await page.waitForLoadState('networkidle', { timeout: 10_000 }); } catch { /**/ }
                break;
            }
        }
    }
}

// ─── Create player (once logged in) ───────────────────────────
async function createPlayerOnMW(page, username, password) {
    await goToUserManagement(page);

    // The account list lives in an AccountsList.aspx iframe
    const getListFrame = () =>
        page.frames().find(f => f.url().includes('AccountsList')) ?? page.mainFrame();

    let listFrame = getListFrame();

    // Open the Create Player dialog via JS to bypass any overlay
    const triggered = await listFrame.evaluate(() => {
        if (typeof showDialog === 'function') { showDialog('6', 'Create Account', 900, 400, 1); return true; }
        const btn = Array.from(document.querySelectorAll('a,button,input'))
            .find(el => (el.innerText || el.value || '').toLowerCase().includes('create'));
        if (btn) { btn.onclick ? btn.onclick() : btn.click(); return true; }
        return false;
    });

    if (!triggered) {
        // Fallback: force-click the Create Player button
        for (const frame of page.frames()) {
            const el = frame.locator('a:has-text("Create Player"), button:has-text("Create Player"), input[value="Create Player"]').first();
            if (await el.count() > 0) { await el.click({ force: true }); break; }
        }
    }

    // Wait for the CreateAccount iframe to appear
    let createFrame = null;
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(500);
        createFrame = page.frames().find(f => f.url().includes('CreateAccount') || f.url().includes('create'));
        if (createFrame) break;
        // Also check if inputs appeared inside the dialog layer directly
        const inDialog = await listFrame.evaluate(() => {
            const d = document.getElementById('DialogBySHFLayer');
            return d ? d.querySelectorAll('input[type="text"],input:not([type])').length : 0;
        }).catch(() => 0);
        if (inDialog > 0) { createFrame = listFrame; break; }
    }

    if (!createFrame) throw new Error('Create Player dialog did not open');

    // Fill the form fields
    const fill = async (hints, value, label) => {
        const strategies = [
            ...hints.map(h => `tr:has(td:has-text("${h}")) input`),
            ...hints.map(h => `input[placeholder*="${h}"]`),
            ...hints.map(h => `label:has-text("${h}") + input`),
        ];
        for (const frame of [createFrame, ...page.frames()]) {
            for (const sel of strategies) {
                const el = frame.locator(sel).first();
                if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                    await el.fill(value);
                    return;
                }
            }
        }
        console.warn(`   ⚠️  [MW Sync] Could not fill "${label}" — skipping`);
    };

    await fill(['Account', 'Username', 'User Name', 'Login name'], username, 'Account');
    await fill(['Login password', 'Password', 'Pass'], password, 'Password');
    await fill(['Confirm password', 'Confirm Password', 'Re-enter'], password, 'Confirm Password');

    // Submit — only look inside the createFrame (not the list frame) to avoid reopening the dialog
    const submitSelectors = [
        'input[value="Create Player"]', 'button:has-text("Create Player")',
        'input[value="Submit"]', 'button:has-text("Submit")',
        'input[value="Save"]', 'input[value="OK"]',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
        const el = createFrame.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
            await el.click({ force: true });
            submitted = true;
            break;
        }
    }
    if (!submitted) {
        await createFrame.evaluate(() => { const f = document.querySelector('form'); if (f) f.submit(); });
    }

    // Close the dialog overlay
    try { await page.waitForLoadState('networkidle', { timeout: 10_000 }); } catch { /**/ }
    await page.evaluate(() => {
        if (typeof CloseDiaLog === 'function') CloseDiaLog();
        const ov = document.getElementById('DialogBySHFLayer');
        if (ov) ov.style.display = 'none';
    }).catch(() => { });

    console.log(`✅ [MW Sync] Player "${username}" created on MilkyWay.`);
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Create a player on MilkyWay, re-logging in if the session expired.
 *
 * @param {string} username
 * @param {string} [password]  Defaults to "Players@123" (same as OceanBets default)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function syncCreatePlayer(username, password = 'Players_123') {
    if (!MW_USER || !MW_PASS) {
        console.log('ℹ️  [MW Sync] Skipped — MW_USER / MW_PASS not configured.');
        return { ok: false, error: 'MW credentials not configured' };
    }

    try {
        const page = await getBrowser();

        // Login if needed (or if session expired)
        if (!loggedIn) await login(page);

        // Verify we are still on an authenticated page; re-login if not
        try {
            await page.goto(`${MW_HOST}/Store.aspx`, { waitUntil: 'load', timeout: 30_000 });
            if (page.url().toLowerCase().includes('default.aspx')) {
                loggedIn = false;
                await login(page);
                await page.goto(`${MW_HOST}/Store.aspx`, { waitUntil: 'load', timeout: 30_000 });
            }
        } catch { /**/ }

        await createPlayerOnMW(page, username, password);
        return { ok: true };
    } catch (err) {
        console.error('❌ [MW Sync] syncCreatePlayer failed:', err.message);
        // Reset session so next call retries login
        loggedIn = false;
        mwPage = null;
        return { ok: false, error: err.message };
    }
}

/**
 * Call this on server startup to pre-warm the MilkyWay session.
 * Avoids a cold-start delay on the first player creation.
 */
export async function warmMilkywaySession() {
    if (!MW_USER || !MW_PASS) return;
    try {
        const page = await getBrowser();
        await login(page);
        await page.goto(`${MW_HOST}/Store.aspx`, { waitUntil: 'load', timeout: 30_000 });
        console.log('🔥 [MW Sync] Session pre-warmed.');
    } catch (err) {
        console.warn('⚠️  [MW Sync] Warm-up failed (will retry on first use):', err.message);
        loggedIn = false;
        mwPage = null;
    }
}
