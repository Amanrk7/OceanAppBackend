/**
 * milkyway-sync.js
 * ─────────────────────────────────────────────────────────────
 * ROOT CAUSE FIX: The MilkyWay login form lives inside an IFRAME,
 * not in the main page frame. Previous versions only searched
 * page.mainFrame() — inputs returned empty every time.
 * This version searches ALL frames on the page.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import Jimp from 'jimp';
import Tesseract from 'tesseract.js';

// ─── Config ───────────────────────────────────────────────────
const MW_BASE  = process.env.MW_BASE || 'https://milkywayapp.xyz:8781';
const MW_USER  = process.env.MW_USER;
const MW_PASS  = process.env.MW_PASS;
const OUTPUT   = './mw-output';
const HEADLESS = process.env.MW_HEADLESS !== 'false';

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
        browser = await chromium.launch({
            headless: HEADLESS,
            args: [
                '--ignore-certificate-errors',
                '--disable-web-security',
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
            ],
        });
        mwPage   = null;
        loggedIn = false;
    }

    if (!mwPage || mwPage.isClosed()) {
        const ctx = await browser.newContext({
            ignoreHTTPSErrors: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 900 },
            javaScriptEnabled: true,
        });
        mwPage = await ctx.newPage();

        // ← THIS IS THE CRITICAL MISSING PIECE
        await mwPage.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        loggedIn = false;
    }
    return mwPage;
}

// ─── Deep debug snapshot — scans ALL frames ───────────────────
async function saveDebugSnapshot(page, label) {
    try {
        await page.screenshot({ path: path.join(OUTPUT, `${label}.png`), fullPage: true });

        // Wait a moment for any lazy-loaded frames/content
        await page.waitForTimeout(1000);

        const allFrames = page.frames();
        console.log(`   🖼️  [MW Sync] [${label}] Total frames: ${allFrames.length}`);

        for (let i = 0; i < allFrames.length; i++) {
            const frame = allFrames[i];
            const frameUrl = frame.url();
            let inputs = [];
            try {
                inputs = await frame.evaluate(() =>
                    Array.from(document.querySelectorAll('input')).map(el => ({
                        id:          el.id          || '(none)',
                        name:        el.name        || '(none)',
                        type:        el.type        || 'text',
                        placeholder: el.placeholder || '(none)',
                        visible:     el.offsetParent !== null,
                    }))
                );
            } catch (_) { /* cross-origin frame — skip */ }

            console.log(`   🔍 [MW Sync] [${label}] Frame[${i}] url="${frameUrl}" inputs=${inputs.length}`);
            if (inputs.length > 0) {
                inputs.forEach(inp =>
                    console.log(`      → id="${inp.id}" name="${inp.name}" type="${inp.type}" placeholder="${inp.placeholder}" visible=${inp.visible}`)
                );
            }
        }
    } catch (e) {
        console.warn(`   ⚠️  [MW Sync] saveDebugSnapshot("${label}") error: ${e.message}`);
    }
}

// ─── Wait for a frame whose URL contains a given string ───────
async function waitForFrame(page, urlFragment, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const frame = page.frames().find(f => f.url().includes(urlFragment));
        if (frame) return frame;
        await page.waitForTimeout(300);
    }
    throw new Error(`Frame containing "${urlFragment}" not found within ${timeoutMs}ms`);
}

// ─── Find input across ALL frames ────────────────────────────
// This is the key fix — MilkyWay login form is in an iframe.
async function findInputAcrossFrames(page, selectorList) {
    const frames = page.frames();
    for (const frame of frames) {
        for (const sel of selectorList) {
            try {
                const el = frame.locator(sel).first();
                if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                    console.log(`   ✅ [MW Sync] Found input via selector "${sel}" in frame: ${frame.url()}`);
                    return { el, frame };
                }
            } catch { /* try next */ }
        }
    }
    return null;
}

// ─── Wait until ANY frame on the page has visible inputs ──────
async function waitForLoginForm(page, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    console.log('   ⏳ [MW Sync] Waiting for login form to appear in any frame…');
    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            try {
                const count = await frame.evaluate(() =>
                    document.querySelectorAll('input[type="text"], input[type="password"]').length
                );
                if (count >= 2) {
                    console.log(`   ✅ [MW Sync] Login form found in frame: ${frame.url()} (${count} inputs)`);
                    return frame;
                }
            } catch { /* cross-origin or not ready yet */ }
        }
        await page.waitForTimeout(500);
    }
    return null;
}

// ─── CAPTCHA solver ───────────────────────────────────────────
async function solveCaptcha(page, loginFrame) {
    const captchaPath = path.join(OUTPUT, 'captcha-raw.png');
    const frameToSearch = loginFrame || page;

    const selectors = [
        'img[src*="aptcha"]', 'img[id*="aptcha"]',
        'img[id*="Image"]',   'img[src*="Verify"]',
        'img[src*="verify"]', 'img[src*="code"]',
        'img[src*="Code"]',   'img[id*="imgCode"]',
        'img[id*="imgVerify"]',
    ];

    let captchaEl = null;
    // Search in the login frame first, then all frames
    const searchFrames = loginFrame ? [loginFrame, ...page.frames()] : page.frames();
    for (const frame of searchFrames) {
        for (const sel of selectors) {
            try {
                const el = frame.locator(sel).first();
                if (await el.count() > 0) {
                    captchaEl = el;
                    break;
                }
            } catch { /* continue */ }
        }
        if (captchaEl) break;
    }

    if (!captchaEl) {
        // Last resort — last img anywhere
        captchaEl = page.locator('img').last();
    }

    try { await captchaEl.waitFor({ state: 'visible', timeout: 8_000 }); }
    catch { return ''; }

    let imageBuffer;
    try {
        const imgSrc = await captchaEl.evaluate(el => el.src);
        const resp   = await page.context().request.get(imgSrc);
        imageBuffer  = await resp.body();
        fs.writeFileSync(captchaPath, imageBuffer);
    } catch {
        try {
            await captchaEl.screenshot({ path: captchaPath });
            imageBuffer = fs.readFileSync(captchaPath);
        } catch { return ''; }
    }

    if (!imageBuffer || imageBuffer.length < 500) return '';

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
    console.log(`   🔡 [MW Sync] CAPTCHA: "${bestCode}" (confidence: ${bestConf.toFixed(0)})`);
    return bestCode;
}

// ─── Login ────────────────────────────────────────────────────
async function login(page) {
    console.log('🔐 [MW Sync] Navigating to login page…');
    try {
        await page.goto(`${MW_BASE}/default.aspx`, { waitUntil: 'networkidle', timeout: 45_000 });
    } catch {
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
    }

    // Extra wait — ASP.NET pages often load frames after the initial load event
    await page.waitForTimeout(5000);

    // Dump ALL frames and ALL inputs (including inside iframes)
    await saveDebugSnapshot(page, 'login-page');

    // Check if already logged in
    const url = page.url().toLowerCase();
    if (!url.includes('default.aspx') && !url.includes('login')) {
        loggedIn = true;
        console.log('✅ [MW Sync] Already logged in — skipping.');
        return;
    }

    const userSelectors = [
        // Placeholder-based
        'input[placeholder="Enter your username"]',
        'input[placeholder*="username" i]',
        'input[placeholder*="user" i]',
        'input[placeholder*="account" i]',
        // Name/ID based — ASP.NET WebForms common patterns
        'input[name*="UserName"]',
        'input[name*="txtUser"]',
        'input[name*="Account"]',
        'input[name*="user"]',
        'input[name*="login"]',
        'input[id*="UserName"]',
        'input[id*="txtUser"]',
        'input[id*="Account"]',
        'input[id*="user"]',
        // Generic: first visible text input
        'input[type="text"]:visible',
        'input[type="text"]',
    ];

    const passSelectors = [
        'input[placeholder="Enter your password"]',
        'input[placeholder*="password" i]',
        'input[type="password"]',
        'input[name*="Password"]',
        'input[name*="txtPass"]',
        'input[id*="Password"]',
        'input[id*="txtPass"]',
    ];

    const captchaInputSelectors = [
        'input[placeholder="Code"]',
        'input[placeholder*="code" i]',
        'input[placeholder*="captcha" i]',
        'input[placeholder*="verify" i]',
        'input[name*="Code"]',
        'input[name*="captcha"]',
        'input[name*="verify"]',
        'input[id*="Code"]',
        'input[id*="txtCode"]',
        'input[id*="captcha"]',
        'input[id*="verify"]',
    ];

    const loginBtnSelectors = [
        'input[value="Login in"]',
        'button:has-text("Login in")',
        'input[value="Login"]',
        'button:has-text("Login")',
        'input[value="Sign in"]',
        'button:has-text("Sign in")',
        'input[type="submit"]',
        'button[type="submit"]',
    ];

    for (let attempt = 1; attempt <= 8; attempt++) {
        console.log(`   🔑 [MW Sync] Login attempt ${attempt}/8…`);

        // ── KEY FIX: wait for login form to appear in any frame ──
        const loginFrame = await waitForLoginForm(page, 15_000);
        if (!loginFrame) {
            console.warn('   ⚠️  [MW Sync] Login form not found in any frame — reloading…');
            await saveDebugSnapshot(page, `login-attempt-${attempt}-no-form`);
            await page.reload({ waitUntil: 'load' });
            await page.waitForTimeout(3000);
            continue;
        }

        // Fill username — search across all frames
        const userResult = await findInputAcrossFrames(page, userSelectors);
        if (!userResult) {
            console.warn('   ⚠️  [MW Sync] Username input not found — reloading…');
            await page.reload({ waitUntil: 'load' });
            await page.waitForTimeout(3000);
            continue;
        }
        await userResult.el.fill(MW_USER);

        // Fill password — search in the same frame first
        const passResult = await findInputAcrossFrames(page, passSelectors);
        if (!passResult) {
            console.warn('   ⚠️  [MW Sync] Password input not found — reloading…');
            await page.reload({ waitUntil: 'load' });
            await page.waitForTimeout(3000);
            continue;
        }
        await passResult.el.fill(MW_PASS);

        // Solve CAPTCHA
        const captchaCode = await solveCaptcha(page, loginFrame);
        if (captchaCode) {
            const capResult = await findInputAcrossFrames(page, captchaInputSelectors);
            if (capResult) {
                await capResult.el.fill(captchaCode);
                console.log(`   ✅ [MW Sync] CAPTCHA filled: "${captchaCode}"`);
            } else {
                console.warn('   ⚠️  [MW Sync] CAPTCHA input not found — proceeding anyway…');
            }
        } else {
            console.warn('   ⚠️  [MW Sync] CAPTCHA solve failed — proceeding anyway…');
        }

        // Click login button
        const btnResult = await findInputAcrossFrames(page, loginBtnSelectors);
        if (btnResult) {
            await btnResult.el.click();
        } else {
            // Try submitting the form inside the login frame directly
            console.warn('   ⚠️  [MW Sync] Login button not found — submitting form…');
            await loginFrame.evaluate(() => {
                const form = document.querySelector('form');
                if (form) form.submit();
            });
        }

        try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); }
        catch { await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }); }

        const newUrl = page.url().toLowerCase();
        console.log(`   🔗 [MW Sync] URL after attempt ${attempt}: ${newUrl}`);

        if (!newUrl.includes('default.aspx') && !newUrl.includes('login')) {
            loggedIn = true;
            console.log('✅ [MW Sync] Login successful!');
            return;
        }

        console.warn(`   ⚠️  [MW Sync] Still on login page after attempt ${attempt}`);
        await saveDebugSnapshot(page, `login-failed-attempt-${attempt}`);
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(2000);
    }
    throw new Error('[MW Sync] Login failed after 8 attempts');
}

// ─── Navigate directly to User Management ─────────────────────
async function goToUserManagement(page) {
    console.log('   📂 [MW Sync] Navigating to User Management…');

    try {
        await page.goto(`${MW_BASE}/AccountsList.aspx`, { waitUntil: 'load', timeout: 20_000 });
        if (page.url().toLowerCase().includes('default.aspx')) {
            throw new Error('Redirected to login — session expired');
        }
        console.log('   ✅ [MW Sync] Reached AccountsList directly.');
        return;
    } catch (directErr) {
        console.warn(`   ⚠️  [MW Sync] Direct nav failed (${directErr.message}), trying frameset…`);
    }

    await page.goto(`${MW_BASE}/Store.aspx`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(2000);

    let leftFrame;
    try {
        leftFrame = await waitForFrame(page, 'Left.aspx', 8_000);
    } catch {
        leftFrame = page.mainFrame();
    }

    const navSelectors = [
        'a:has-text("User Management")',
        'span:has-text("User Management")',
        'li:has-text("User Management")',
        'td:has-text("User Management")',
    ];
    let clicked = false;
    for (const sel of navSelectors) {
        try {
            const el = leftFrame.locator(sel).first();
            if (await el.count() > 0) {
                await el.click();
                clicked = true;
                break;
            }
        } catch { /* continue */ }
    }
    if (!clicked) throw new Error('[MW Sync] Could not find "User Management" link in sidebar');

    try { await page.waitForLoadState('networkidle', { timeout: 15_000 }); }
    catch { await page.waitForTimeout(2000); }

    console.log('   ✅ [MW Sync] Navigated to User Management via sidebar.');
}

// ─── Create player once on the User Management page ───────────
async function createPlayerOnMW(page, username, password) {
    await goToUserManagement(page);
    await page.waitForTimeout(2000);

    let listFrame;
    try {
        listFrame = await waitForFrame(page, 'AccountsList', 10_000);
        console.log('   🖼️  [MW Sync] AccountsList frame found.');
    } catch {
        console.warn('   ⚠️  [MW Sync] AccountsList frame not found — using main frame.');
        listFrame = page.mainFrame();
    }

    await saveDebugSnapshot(page, 'user-management');

    console.log('   🖱️  [MW Sync] Looking for Create Player button…');
    const createBtnSelectors = [
        'input[value="Create Player"]',
        'button:has-text("Create Player")',
        'a:has-text("Create Player")',
        'input[value*="Create" i]',
        'button:has-text("Create")',
    ];

    let btnClicked = false;

    // Search all frames
    for (const frame of page.frames()) {
        for (const sel of createBtnSelectors) {
            try {
                const el = frame.locator(sel).first();
                if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                    await el.click({ force: true });
                    btnClicked = true;
                    console.log(`   ✅ [MW Sync] Clicked Create Player (frame: ${frame.url()}) (${sel})`);
                    break;
                }
            } catch { /* continue */ }
        }
        if (btnClicked) break;
    }

    if (!btnClicked) {
        console.warn('   ⚠️  [MW Sync] Button not found — trying JS showDialog…');
        const triggered = await listFrame.evaluate(() => {
            if (typeof showDialog === 'function') {
                showDialog('6', 'Create Account', 900, 400, 1);
                return true;
            }
            return false;
        });
        if (!triggered) throw new Error('[MW Sync] Could not open Create Player dialog');
    }

    console.log('   ⏳ [MW Sync] Waiting for Create Account form…');
    let createFrame = null;
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(500);
        createFrame = page.frames().find(
            f => f.url().includes('CreateAccount') || f.url().includes('create')
        );
        if (createFrame) break;

        const inDialog = await listFrame.evaluate(() => {
            const d = document.getElementById('DialogBySHFLayer');
            return d ? d.querySelectorAll('input[type="text"],input:not([type="hidden"]):not([type="submit"]):not([type="button"])').length : 0;
        }).catch(() => 0);
        if (inDialog >= 2) { createFrame = listFrame; break; }
    }

    if (!createFrame) {
        await saveDebugSnapshot(page, 'debug-no-dialog');
        throw new Error('[MW Sync] Create Player dialog did not appear (snapshot saved)');
    }
    console.log('   ✅ [MW Sync] Create Account form found.');

    const fill = async (hints, value, label) => {
        const strategies = [
            ...hints.map(h => `tr:has(td:has-text("${h}")) input`),
            ...hints.map(h => `input[placeholder*="${h}" i]`),
            ...hints.map(h => `input[name*="${h}" i]`),
            ...hints.map(h => `input[id*="${h}" i]`),
            ...hints.map(h => `label:has-text("${h}") + input`),
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
        try {
            const el = createFrame.locator(sel).first();
            if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                await el.click({ force: true });
                submitted = true;
                console.log(`   ✅ [MW Sync] Submitted via "${sel}"`);
                break;
            }
        } catch { /* continue */ }
    }
    if (!submitted) {
        await createFrame.evaluate(() => { const f = document.querySelector('form'); if (f) f.submit(); });
        console.warn('   ⚠️  [MW Sync] Used form.submit() fallback');
    }

    try { await page.waitForLoadState('networkidle', { timeout: 10_000 }); } catch { /**/ }
    await page.evaluate(() => {
        if (typeof CloseDiaLog === 'function') CloseDiaLog();
        const ov = document.getElementById('DialogBySHFLayer');
        if (ov) ov.style.display = 'none';
    }).catch(() => { });

    console.log(`✅ [MW Sync] Player "${username}" created on MilkyWay.`);
}

// ─── Public API ───────────────────────────────────────────────

export async function syncCreatePlayer(username, password = 'Players@123') {
    if (!MW_USER || !MW_PASS) {
        console.log('ℹ️  [MW Sync] Skipped — MW_USER / MW_PASS not configured.');
        return { ok: false, error: 'MW credentials not configured' };
    }

    try {
        const page = await getBrowser();
        if (!loggedIn) await login(page);

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
        loggedIn = false;
        mwPage   = null;
        return { ok: false, error: err.message };
    }
}

export async function warmMilkywaySession() {
    if (!MW_USER || !MW_PASS) return;
    try {
        const page = await getBrowser();
        await login(page);
        await page.goto(`${MW_BASE}/Store.aspx`, { waitUntil: 'load', timeout: 30_000 });
        console.log('🔥 [MW Sync] Session pre-warmed.');
    } catch (err) {
        console.warn(`⚠️  [MW Sync] Warm-up failed (will retry on first use): ${err.message}`);
        loggedIn = false;
        mwPage   = null;
    }
}

/*
 ─── RENDER ENV VARS ─────────────────────────────────────────────
   MW_BASE = https://milkywayapp.xyz:8781
   MW_USER = your_milkyway_username
   MW_PASS = your_milkyway_password

 ─── WHAT TO LOOK FOR IN LOGS AFTER DEPLOYING ────────────────────
 The saveDebugSnapshot now scans EVERY frame. You should see:

    Frame[0] url="https://milkywayapp.xyz:8781/default.aspx" inputs=0
    Frame[1] url="https://milkywayapp.xyz:8781/Login.aspx"   inputs=3
       → id="txtUserName" name="txtUserName" type="text" ...
       → id="txtPassword" name="txtPassword" type="password" ...
       → id="txtCode"     name="txtCode"     type="text" ...

 If you still see 0 inputs in all frames, paste the logs here.
*/
