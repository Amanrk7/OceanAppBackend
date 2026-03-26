/**
 * milkyway-sync.js
 * ─────────────────────────────────────────────────────────────
 * Key fixes:
 *  1. MW_BASE is base URL only (no /Store.aspx suffix)
 *  2. Login uses many selector fallbacks — dumps page HTML + input list for debugging
 *  3. All page.goto() calls use MW_BASE + correct path
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

// ─── Save debug snapshot (screenshot + HTML + input list) ─────
async function saveDebugSnapshot(page, label) {
    try {
        await page.screenshot({ path: path.join(OUTPUT, `${label}.png`), fullPage: true });
        const html = await page.content();
        fs.writeFileSync(path.join(OUTPUT, `${label}.html`), html);

        // Log every input on the page so we know the exact selectors to use
        const inputs = await page.evaluate(() =>
            Array.from(document.querySelectorAll('input')).map(el => ({
                id:          el.id          || '(none)',
                name:        el.name        || '(none)',
                type:        el.type        || '(none)',
                placeholder: el.placeholder || '(none)',
                className:   el.className   || '(none)',
                visible:     el.offsetParent !== null,
            }))
        );
        console.log(`   📸 [MW Sync] Snapshot → mw-output/${label}.png + .html`);
        console.log(`   🔍 [MW Sync] ALL INPUTS on page [${label}]:\n` +
            inputs.map(i =>
                `      id="${i.id}" name="${i.name}" type="${i.type}" placeholder="${i.placeholder}" visible=${i.visible}`
            ).join('\n')
        );

        const frameUrls = page.frames().map(f => f.url());
        console.log(`   🖼️  [MW Sync] Frames [${label}]: ${frameUrls.join(', ')}`);
    } catch (e) {
        console.warn(`   ⚠️  [MW Sync] saveDebugSnapshot("${label}") failed: ${e.message}`);
    }
}

// ─── Wait for a frame whose URL contains a given string ───────
async function waitForFrame(page, urlFragment, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const frame = page.frames().find(f => f.url().includes(urlFragment));
        if (frame) return frame;
        await page.waitForTimeout(400);
    }
    const frameUrls = page.frames().map(f => f.url()).join('\n  ');
    throw new Error(`Frame containing "${urlFragment}" not found within ${timeoutMs}ms.\nFrames:\n  ${frameUrls}`);
}

// ─── Find an input by trying many selectors ───────────────────
async function findInput(frame, selectorList) {
    for (const sel of selectorList) {
        try {
            const el = frame.locator(sel).first();
            if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                console.log(`   ✅ [MW Sync] Found input via selector: ${sel}`);
                return el;
            }
        } catch { /* continue */ }
    }
    return null;
}

// ─── CAPTCHA solver ───────────────────────────────────────────
async function solveCaptcha(page) {
    const captchaPath = path.join(OUTPUT, 'captcha-raw.png');

    const selectors = [
        'img[src*="aptcha"]', 'img[id*="aptcha"]',
        'img[id*="Image"]',   'img[src*="Verify"]',
        'img[src*="verify"]', 'img[src*="code"]',
        'img[src*="Code"]',   'img[id*="imgCode"]',
        'img[id*="imgVerify"]',
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
        await page.goto(`${MW_BASE}/default.aspx`, { waitUntil: 'load', timeout: 45_000 });
    } catch {
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
    }

    // Always dump the page — this prints all input id/name/type/placeholder to logs
    await saveDebugSnapshot(page, 'login-page');

    // Already logged in?
    const url = page.url().toLowerCase();
    if (!url.includes('default.aspx') && !url.includes('login')) {
        loggedIn = true;
        console.log('✅ [MW Sync] Session still active — skipping login.');
        return;
    }

    // ── Selectors — wide net covering ASP.NET WebForms naming conventions ──
    const userSelectors = [
        // Placeholder-based
        'input[placeholder="Enter your username"]',
        'input[placeholder*="username" i]',
        'input[placeholder*="user" i]',
        'input[placeholder*="account" i]',
        // Name-based (ASP.NET WebForms: ctl00$ContentPlaceHolder1$txtUserName etc.)
        'input[name*="UserName" i]',
        'input[name*="txtUser" i]',
        'input[name*="Account" i]',
        'input[name*="user" i]',
        'input[name*="login" i]',
        // ID-based
        'input[id*="UserName" i]',
        'input[id*="txtUser" i]',
        'input[id*="Account" i]',
        'input[id*="user" i]',
        // Generic fallback — first visible text input
        'input[type="text"]:visible',
    ];

    const passSelectors = [
        'input[placeholder="Enter your password"]',
        'input[placeholder*="password" i]',
        'input[placeholder*="pass" i]',
        'input[type="password"]',
        'input[name*="Password" i]',
        'input[name*="txtPass" i]',
        'input[name*="pass" i]',
        'input[id*="Password" i]',
        'input[id*="txtPass" i]',
    ];

    const captchaSelectors = [
        'input[placeholder="Code"]',
        'input[placeholder*="code" i]',
        'input[placeholder*="captcha" i]',
        'input[placeholder*="verify" i]',
        'input[name*="Code" i]',
        'input[name*="captcha" i]',
        'input[name*="verify" i]',
        'input[id*="Code" i]',
        'input[id*="txtCode" i]',
        'input[id*="captcha" i]',
        'input[id*="verify" i]',
    ];

    const loginBtnSelectors = [
        'button:has-text("Login in")',
        'input[value="Login in"]',
        'button:has-text("Login")',
        'input[value="Login"]',
        'button:has-text("Sign in")',
        'input[value="Sign in"]',
        'button[type="submit"]',
        'input[type="submit"]',
    ];

    for (let attempt = 1; attempt <= 8; attempt++) {
        console.log(`   🔑 [MW Sync] Login attempt ${attempt}/8…`);

        const userInput = await findInput(page.mainFrame(), userSelectors);
        if (!userInput) {
            console.warn('   ⚠️  [MW Sync] Username field not visible — saving snapshot & reloading…');
            await saveDebugSnapshot(page, `login-attempt-${attempt}-no-form`);
            await page.reload({ waitUntil: 'load' });
            await page.waitForTimeout(2000);
            continue;
        }

        await userInput.fill(MW_USER);

        const passInput = await findInput(page.mainFrame(), passSelectors);
        if (!passInput) {
            console.warn('   ⚠️  [MW Sync] Password field not found — reloading…');
            await page.reload({ waitUntil: 'load' });
            continue;
        }
        await passInput.fill(MW_PASS);

        const captchaCode = await solveCaptcha(page);
        if (!captchaCode) {
            console.warn('   ⚠️  [MW Sync] Could not solve CAPTCHA — retrying…');
            await page.reload({ waitUntil: 'load' });
            continue;
        }

        const captchaInput = await findInput(page.mainFrame(), captchaSelectors);
        if (captchaInput) {
            await captchaInput.fill(captchaCode);
        } else {
            console.warn('   ⚠️  [MW Sync] CAPTCHA input not found — proceeding anyway…');
        }

        const loginBtn = await findInput(page.mainFrame(), loginBtnSelectors);
        if (loginBtn) {
            await loginBtn.click();
        } else {
            console.warn('   ⚠️  [MW Sync] Login button not found — submitting form directly…');
            await page.evaluate(() => { const f = document.querySelector('form'); if (f) f.submit(); });
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
        await page.waitForTimeout(1000);
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

    for (const sel of createBtnSelectors) {
        const el = listFrame.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
            await el.click({ force: true });
            btnClicked = true;
            console.log(`   ✅ [MW Sync] Clicked Create Player button (${sel})`);
            break;
        }
    }

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
        btnClicked = true;
    }

    console.log('   ⏳ [MW Sync] Waiting for Create Account form…');
    let createFrame = null;
    for (let i = 0; i < 25; i++) {
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
 ─── AFTER DEPLOYING: what to look for in Render logs ────────────

 Look for this block right after server starts:

    🔍 [MW Sync] ALL INPUTS on page [login-page]:
       id="txtUserName" name="ctl00$txtUserName" type="text" placeholder="(none)" visible=true
       id="txtPassword" name="ctl00$txtPassword" type="password" placeholder="(none)" visible=true
       id="txtCode"     name="ctl00$txtCode"     type="text"     placeholder="(none)" visible=true

 Copy and paste those lines here — we'll use the exact id/name
 values to hard-code the selectors and make it 100% reliable.

 ─── RENDER ENV VARS ─────────────────────────────────────────────
   MW_BASE = https://milkywayapp.xyz:8781    ← no trailing slash
   MW_USER = your_milkyway_username
   MW_PASS = your_milkyway_password
*/
