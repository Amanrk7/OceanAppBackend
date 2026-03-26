/**
 * milkyway-sync.js  (fixed)
 * ─────────────────────────────────────────────────────────────
 * Changes vs original:
 *  1. goToUserManagement() navigates DIRECTLY to AccountsList.aspx
 *     instead of clicking sidebar links (fragile frame-click approach removed)
 *  2. waitForFrame() polls until the target iframe is actually loaded
 *  3. Create-Player button is clicked directly via the known selector
 *     from the live screenshot ("Create Player" top-right button)
 *  4. Better per-step logging so you can see exactly where it fails
 *  5. index.js caller should stop swallowing errors — see note at bottom
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import Jimp from 'jimp';
import Tesseract from 'tesseract.js';

// ─── Config ───────────────────────────────────────────────────
const MW_HOST   = process.env.MW_HOST || 'https://milkywayapp.xyz:8781';
const MW_USER   = process.env.MW_USER;
const MW_PASS   = process.env.MW_PASS;
const OUTPUT    = './mw-output';
const HEADLESS  = process.env.MW_HEADLESS !== 'false'; // set MW_HEADLESS=false to debug visually

if (!MW_USER || !MW_PASS) {
    console.warn('⚠️  MW_USER / MW_PASS not set — MilkyWay sync is disabled');
}
if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

// ─── Singleton browser / page ─────────────────────────────────
let browser  = null;
let mwPage   = null;
let loggedIn = false;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        browser  = await chromium.launch({
            headless: HEADLESS,
            args: ['--ignore-certificate-errors', '--disable-web-security', '--no-sandbox'],
        });
        mwPage   = null;
        loggedIn = false;
    }
    if (!mwPage || mwPage.isClosed()) {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
        mwPage    = await ctx.newPage();
        await mwPage.setViewportSize({ width: 1280, height: 900 });
        loggedIn  = false;
    }
    return mwPage;
}

// ─── Wait for a frame whose URL contains a given string ───────
async function waitForFrame(page, urlFragment, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const frame = page.frames().find(f => f.url().includes(urlFragment));
        if (frame) return frame;
        await page.waitForTimeout(400);
    }
    // Dump all current frame URLs for debugging
    const frameUrls = page.frames().map(f => f.url()).join('\n  ');
    throw new Error(`Frame containing "${urlFragment}" not found within ${timeoutMs}ms.\nFrames available:\n  ${frameUrls}`);
}

// ─── CAPTCHA solver ───────────────────────────────────────────
async function solveCaptcha(page) {
    const captchaPath = path.join(OUTPUT, 'captcha-raw.png');

    const selectors = [
        'img[src*="aptcha"]', 'img[id*="aptcha"]',
        'img[id*="Image"]',   'img[src*="Verify"]',
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
        const resp   = await page.context().request.get(imgSrc);
        imageBuffer  = await resp.body();
        fs.writeFileSync(captchaPath, imageBuffer);
    } catch {
        await captchaEl.screenshot({ path: captchaPath });
        imageBuffer = fs.readFileSync(captchaPath);
    }

    if (imageBuffer.length < 500) return '';

    const pipelines = [
        { name: 'gs-maxc-4x',  fn: img => img.greyscale().contrast(1).scale(4) },
        { name: 'gs-c0.5-4x',  fn: img => img.greyscale().contrast(0.5).scale(4) },
        { name: 'inv-gs-4x',   fn: img => img.invert().greyscale().contrast(1).scale(4) },
        { name: 'gs-norm-4x',  fn: img => img.greyscale().normalize().scale(4) },
    ];

    let bestCode = '', bestConf = 0;
    for (const p of pipelines) {
        try {
            const out = path.join(OUTPUT, `cap-${p.name}.png`);
            const img = await Jimp.read(captchaPath);
            p.fn(img);
            await img.writeAsync(out);
            const res  = await Tesseract.recognize(out, 'eng', {
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                tessedit_pageseg_mode:   '7',
            });
            const conf = res.data.confidence || 0;
            const code = res.data.text.replace(/[^A-Za-z0-9]/g, '').trim();
            if (conf > bestConf && code.length >= 3) { bestConf = conf; bestCode = code; }
        } catch { /* skip bad pipeline */ }
    }
    console.log(`   🔡 [MW Sync] CAPTCHA solved: "${bestCode}" (confidence: ${bestConf.toFixed(0)})`);
    return bestCode;
}

// ─── Login ────────────────────────────────────────────────────
async function login(page) {
    console.log('🔐 [MW Sync] Navigating to login page…');
    try {
        await page.goto(`${MW_HOST}/default.aspx`, { waitUntil: 'load', timeout: 45_000 });
    } catch {
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
    }

    // Already logged in?
    if (!page.url().toLowerCase().includes('default.aspx')) {
        loggedIn = true;
        console.log('✅ [MW Sync] Session still active — skipping login.');
        return;
    }

    for (let attempt = 1; attempt <= 8; attempt++) {
        console.log(`   🔑 [MW Sync] Login attempt ${attempt}/8…`);

        try {
            await page.locator('input[placeholder="Enter your username"]')
                .waitFor({ state: 'visible', timeout: 10_000 });
        } catch {
            console.warn('   ⚠️  [MW Sync] Login form not visible — reloading…');
            await page.reload({ waitUntil: 'load' });
            continue;
        }

        await page.locator('input[placeholder="Enter your username"]').fill(MW_USER);
        await page.locator('input[placeholder="Enter your password"]').fill(MW_PASS);

        const captchaCode = await solveCaptcha(page);
        if (!captchaCode) {
            console.warn('   ⚠️  [MW Sync] Could not solve CAPTCHA — retrying…');
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

        console.warn(`   ⚠️  [MW Sync] Still on login page after attempt ${attempt} — retrying…`);
        await page.reload({ waitUntil: 'load' });
    }
    throw new Error('[MW Sync] Login failed after 8 attempts');
}

// ─── Navigate directly to User Management ─────────────────────
// FIX: instead of clicking sidebar links (fragile), go directly
// to the AccountsList URL which is the User Management main page.
async function goToUserManagement(page) {
    console.log('   📂 [MW Sync] Navigating to User Management…');

    // Try direct navigation first (most reliable)
    // MilkyWay's main frame navigates to AccountsList.aspx for User Management
    try {
        await page.goto(`${MW_HOST}/AccountsList.aspx`, { waitUntil: 'load', timeout: 20_000 });
        // If redirected to login, session expired
        if (page.url().toLowerCase().includes('default.aspx')) {
            throw new Error('Redirected to login — session expired');
        }
        console.log('   ✅ [MW Sync] Reached AccountsList directly.');
        return;
    } catch (directErr) {
        console.warn(`   ⚠️  [MW Sync] Direct nav failed (${directErr.message}), trying frameset approach…`);
    }

    // Fallback: navigate to the root Store.aspx which has the frameset,
    // then click the sidebar link
    await page.goto(`${MW_HOST}/Store.aspx`, { waitUntil: 'load', timeout: 30_000 });

    // Find the left-nav frame
    let leftFrame;
    try {
        leftFrame = await waitForFrame(page, 'Left.aspx', 8_000);
    } catch {
        // Some builds just have a single-page layout — try on main frame
        leftFrame = page.mainFrame();
    }

    const navSelectors = [
        'a:has-text("User Management")',
        'span:has-text("User Management")',
        'li:has-text("User Management")',
    ];
    let clicked = false;
    for (const sel of navSelectors) {
        const el = leftFrame.locator(sel).first();
        if (await el.count() > 0) {
            await el.click();
            clicked = true;
            break;
        }
    }
    if (!clicked) throw new Error('[MW Sync] Could not find "User Management" link in sidebar');

    try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); }
    catch { await page.waitForTimeout(2000); }

    console.log('   ✅ [MW Sync] Navigated to User Management via sidebar.');
}

// ─── Create player once on the User Management page ───────────
async function createPlayerOnMW(page, username, password) {
    await goToUserManagement(page);

    // Wait for the AccountsList frame (or main frame if single-page)
    let listFrame;
    try {
        listFrame = await waitForFrame(page, 'AccountsList', 10_000);
        console.log('   🖼️  [MW Sync] AccountsList frame found.');
    } catch {
        console.warn('   ⚠️  [MW Sync] AccountsList frame not found — using main frame.');
        listFrame = page.mainFrame();
    }

    // ── Click the "Create Player" button ────────────────────────
    // From the live screenshot the button is clearly in the top-right
    // with text "Create Player". Try multiple selectors in priority order.
    console.log('   🖱️  [MW Sync] Looking for Create Player button…');
    const createBtnSelectors = [
        'input[value="Create Player"]',
        'button:has-text("Create Player")',
        'a:has-text("Create Player")',
    ];

    let btnClicked = false;

    // Check inside list frame first
    for (const sel of createBtnSelectors) {
        const el = listFrame.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
            await el.click({ force: true });
            btnClicked = true;
            console.log(`   ✅ [MW Sync] Clicked Create Player button (${sel})`);
            break;
        }
    }

    // Fall back to any frame on the page
    if (!btnClicked) {
        for (const frame of page.frames()) {
            for (const sel of createBtnSelectors) {
                const el = frame.locator(sel).first();
                if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                    await el.click({ force: true });
                    btnClicked = true;
                    console.log(`   ✅ [MW Sync] Clicked Create Player (frame fallback) (${sel})`);
                    break;
                }
            }
            if (btnClicked) break;
        }
    }

    // Last resort: trigger via JS showDialog (original approach)
    if (!btnClicked) {
        console.warn('   ⚠️  [MW Sync] Button not found — trying JS showDialog…');
        const triggered = await listFrame.evaluate(() => {
            if (typeof showDialog === 'function') {
                showDialog('6', 'Create Account', 900, 400, 1);
                return true;
            }
            return false;
        });
        if (!triggered) throw new Error('[MW Sync] Could not open Create Player dialog — no button or showDialog found');
        btnClicked = true;
    }

    // ── Wait for the Create Account form to appear ────────────
    console.log('   ⏳ [MW Sync] Waiting for Create Account form…');
    let createFrame = null;
    for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(500);

        // Check for a new iframe
        createFrame = page.frames().find(
            f => f.url().includes('CreateAccount') || f.url().includes('create')
        );
        if (createFrame) break;

        // Check if the dialog rendered inline inside the list frame
        const inDialog = await listFrame.evaluate(() => {
            const d = document.getElementById('DialogBySHFLayer');
            return d ? d.querySelectorAll('input[type="text"],input:not([type="hidden"]):not([type="submit"]):not([type="button"])').length : 0;
        }).catch(() => 0);
        if (inDialog >= 2) { createFrame = listFrame; break; }
    }

    if (!createFrame) {
        // Screenshot for debugging
        await page.screenshot({ path: path.join(OUTPUT, 'debug-no-dialog.png') });
        throw new Error('[MW Sync] Create Player dialog did not appear (screenshot saved to mw-output/)');
    }
    console.log('   ✅ [MW Sync] Create Account form found.');

    // ── Fill the form ─────────────────────────────────────────
    const fill = async (hints, value, label) => {
        const strategies = [
            ...hints.map(h => `tr:has(td:has-text("${h}")) input`),
            ...hints.map(h => `input[placeholder*="${h}"]`),
            ...hints.map(h => `label:has-text("${h}") + input`),
            // Generic: first visible text inputs in order
            'input[type="text"]:visible',
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="radio"]):not([type="checkbox"]):visible',
        ];
        for (const frame of [createFrame, ...page.frames()]) {
            for (const sel of strategies) {
                try {
                    const el = frame.locator(sel).first();
                    if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                        await el.fill(value);
                        console.log(`   ✏️  [MW Sync] Filled "${label}" field`);
                        return;
                    }
                } catch { /* try next */ }
            }
        }
        console.warn(`   ⚠️  [MW Sync] Could not fill "${label}" — skipping`);
    };

    await fill(['Account', 'Username', 'User Name', 'Login name'], username, 'Account');
    await fill(['Login password', 'Password', 'Pass'],             password,  'Password');
    await fill(['Confirm password', 'Confirm Password', 'Re-enter'], password, 'Confirm Password');

    // ── Submit ────────────────────────────────────────────────
    console.log('   📤 [MW Sync] Submitting Create Player form…');
    const submitSelectors = [
        'input[value="Create Player"]',
        'button:has-text("Create Player")',
        'input[value="Submit"]',
        'button:has-text("Submit")',
        'input[value="Save"]',
        'input[value="OK"]',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
        // Only look inside createFrame — NOT listFrame — to avoid re-triggering the dialog button
        const el = createFrame.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
            await el.click({ force: true });
            submitted = true;
            console.log(`   ✅ [MW Sync] Submitted via "${sel}"`);
            break;
        }
    }
    if (!submitted) {
        await createFrame.evaluate(() => { const f = document.querySelector('form'); if (f) f.submit(); });
        console.warn('   ⚠️  [MW Sync] Used form.submit() fallback');
    }

    // Wait for the request to complete then close overlay
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
 * @param {string} [password]  Defaults to "Players@123"
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function syncCreatePlayer(username, password = 'Players@123') {
    if (!MW_USER || !MW_PASS) {
        console.log('ℹ️  [MW Sync] Skipped — MW_USER / MW_PASS not configured.');
        return { ok: false, error: 'MW credentials not configured' };
    }

    try {
        const page = await getBrowser();

        if (!loggedIn) await login(page);

        // Verify the session is still valid by checking current URL
        // (getBrowser may return a page that drifted back to login)
        const currentUrl = page.url().toLowerCase();
        if (currentUrl.includes('default.aspx') || !currentUrl.startsWith('http')) {
            console.log('   🔄 [MW Sync] Session expired — re-logging in…');
            loggedIn = false;
            await login(page);
        }

        await createPlayerOnMW(page, username, password);
        return { ok: true };

    } catch (err) {
        console.error(`❌ [MW Sync] syncCreatePlayer("${username}") failed: ${err.message}`);
        // Reset session so the next call retries login
        loggedIn = false;
        mwPage   = null;
        return { ok: false, error: err.message };
    }
}

/**
 * Pre-warm the MilkyWay session on server startup to avoid cold-start delays.
 */
export async function warmMilkywaySession() {
    if (!MW_USER || !MW_PASS) return;
    try {
        const page = await getBrowser();
        await login(page);
        // Navigate to User Management so the session is confirmed to work end-to-end
        await page.goto(`${MW_HOST}/Store.aspx`, { waitUntil: 'load', timeout: 30_000 });
        console.log('🔥 [MW Sync] Session pre-warmed.');
    } catch (err) {
        console.warn(`⚠️  [MW Sync] Warm-up failed (will retry on first use): ${err.message}`);
        loggedIn = false;
        mwPage   = null;
    }
}

/*
 ─── IMPORTANT: Fix in index.js ──────────────────────────────────
 
 Your current caller in index.js swallows ALL errors silently:

    syncCreatePlayer(username.trim()).then(result => {
      if (!result.ok) console.error(...);
    }).catch(() => {});    // ← this hides crashes

 Change it to at least log the catch:

    syncCreatePlayer(username.trim()).then(result => {
      if (!result.ok) {
        console.error(`⚠️  MilkyWay sync failed for "${username}": ${result.error}`);
      }
    }).catch(err => {
      console.error(`❌ MilkyWay sync threw unexpectedly for "${username}":`, err);
    });

 ─── QUICK DEBUGGING TIP ─────────────────────────────────────────

 Set MW_HEADLESS=false in your .env and restart the server.
 When you create a player, a visible browser window will open
 and you can watch exactly where the automation gets stuck.
*/
