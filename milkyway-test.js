/**
 * milkyway-test.js  (fixed - login searches all frames)
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import Jimp from 'jimp';
import Tesseract from 'tesseract.js';

// ─── Config ───────────────────────────────────────────────────
const MW_HOST  = process.env.MW_HOST || 'https://milkywayapp.xyz:8781/Store.aspx';
const MW_USER  = process.env.MW_USER;
const MW_PASS  = process.env.MW_PASS;
const OUTPUT   = './mw-output';
const HEADLESS = process.env.MW_HEADLESS !== 'false';

if (!MW_USER || !MW_PASS) {
    console.warn('⚠️  MW_USER / MW_PASS not set — MilkyWay sync is disabled');
}
if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

// ─── Singleton ────────────────────────────────────────────────
let browser  = null;
let mwPage   = null;
let loggedIn = false;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        browser  = await chromium.launch({
            headless: HEADLESS,
            args: ['--ignore-certificate-errors', '--disable-web-security', '--no-sandbox', '--disable-setuid-sandbox'],
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

// ─── Wait for a frame by URL fragment ─────────────────────────
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

// ─── Find login form across ALL frames ────────────────────────
// MilkyWay's default.aspx is a frameset — the login form lives
// inside one of the child frames, not the main frame.
async function findLoginFrame(page) {
    const frames = page.frames();
    console.log(`   🔍 [MW Sync] Scanning ${frames.length} frame(s) for login form...`);

    for (const frame of frames) {
        try {
            const count = await frame.locator('input[placeholder="Enter your username"]').count();
            if (count > 0) {
                console.log(`   ✅ [MW Sync] Login form found in frame: ${frame.url()}`);
                return frame;
            }
        } catch { /* frame may have navigated away */ }
    }

    // Fallback: look for any username/password input pair
    for (const frame of frames) {
        try {
            const userCount = await frame.locator('input[type="text"]').count();
            const passCount = await frame.locator('input[type="password"]').count();
            if (userCount > 0 && passCount > 0) {
                console.log(`   ✅ [MW Sync] Login form (fallback) found in frame: ${frame.url()}`);
                return frame;
            }
        } catch { /* skip */ }
    }

    return null;
}

// ─── CAPTCHA solver ───────────────────────────────────────────
async function solveCaptcha(frame) {
    const captchaPath = path.join(OUTPUT, 'captcha-raw.png');

    const selectors = [
        'img[src*="aptcha"]', 'img[id*="aptcha"]',
        'img[id*="Image"]',   'img[src*="Verify"]',
        'img[src*="verify"]', 'img[src*="code"]',
    ];
    let captchaEl = null;
    for (const sel of selectors) {
        const el = frame.locator(sel).first();
        if (await el.count() > 0) { captchaEl = el; break; }
    }
    if (!captchaEl) captchaEl = frame.locator('img').last();

    try { await captchaEl.waitFor({ state: 'visible', timeout: 8_000 }); }
    catch { return ''; }

    let imageBuffer;
    try {
        const imgSrc = await captchaEl.evaluate(el => el.src);
        // Request via the frame's page context so cookies are sent
        const resp   = await frame.page().context().request.get(imgSrc);
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
        } catch { /* skip */ }
    }
    console.log(`   🔡 [MW Sync] CAPTCHA: "${bestCode}" (confidence: ${bestConf.toFixed(0)})`);
    return bestCode;
}

// ─── Login ────────────────────────────────────────────────────
async function login(page) {
    console.log('🔐 [MW Sync] Navigating to login page…');

    await page.goto(`${MW_HOST}/default.aspx`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
    }).catch(() => {});

    // Give frames time to load
    await page.waitForTimeout(3000);

    // Already logged in?
    const alreadyIn = page.frames().some(f =>
        f.url().includes('Store.aspx') ||
        f.url().includes('AccountsList') ||
        f.url().includes('Left.aspx')
    );
    if (alreadyIn) {
        loggedIn = true;
        console.log('✅ [MW Sync] Session still active — skipping login.');
        return;
    }

    for (let attempt = 1; attempt <= 8; attempt++) {
        console.log(`   🔑 [MW Sync] Login attempt ${attempt}/8…`);

        // Give the page time to load frames
        await page.waitForTimeout(2000);

        // Log all frame URLs for debugging
        const frameUrls = page.frames().map(f => f.url());
        console.log(`   🖼️  [MW Sync] Frames: ${frameUrls.join(' | ')}`);

        // Screenshot for debugging on first attempt
        if (attempt === 1) {
            await page.screenshot({ path: path.join(OUTPUT, `login-attempt-${attempt}.png`) }).catch(() => {});
        }

        const loginFrame = await findLoginFrame(page);

        if (!loginFrame) {
            console.warn(`   ⚠️  [MW Sync] Login form not found in any frame — reloading…`);
            await page.goto(`${MW_HOST}/default.aspx`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
            await page.waitForTimeout(3000);
            continue;
        }

        // Fill credentials
        await loginFrame.locator('input[placeholder="Enter your username"], input[type="text"]').first().fill(MW_USER);
        await loginFrame.locator('input[placeholder="Enter your password"], input[type="password"]').first().fill(MW_PASS);

        const captchaCode = await solveCaptcha(loginFrame);
        if (captchaCode) {
            const codeInput = loginFrame.locator('input[placeholder="Code"], input[name*="ode"], input[id*="ode"]').first();
            if (await codeInput.count() > 0) {
                await codeInput.fill(captchaCode);
            }
        }

        // Click login button
        const loginBtn = loginFrame.locator('button:has-text("Login"), input[value*="Login"], button:has-text("Sign in")').first();
        if (await loginBtn.count() > 0) {
            await loginBtn.click();
        } else {
            // Submit the form
            await loginFrame.evaluate(() => document.querySelector('form')?.submit());
        }

        await page.waitForTimeout(4000);

        // Check if login succeeded — look for authenticated frames
        const authenticated = page.frames().some(f =>
            f.url().includes('Store.aspx') ||
            f.url().includes('AccountsList') ||
            f.url().includes('Left.aspx') ||
            (!f.url().includes('default.aspx') && f.url().includes(MW_HOST.replace('https://', '').replace('http://', '')))
        );

        if (authenticated) {
            loggedIn = true;
            console.log('✅ [MW Sync] Login successful!');
            return;
        }

        console.warn(`   ⚠️  [MW Sync] Still not authenticated after attempt ${attempt}…`);
        await page.goto(`${MW_HOST}/default.aspx`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(3000);
    }

    // Save final screenshot for debugging
    await page.screenshot({ path: path.join(OUTPUT, 'login-failed.png') }).catch(() => {});
    throw new Error('[MW Sync] Login failed after 8 attempts');
}

// ─── Navigate to User Management ──────────────────────────────
async function goToUserManagement(page) {
    console.log('   📂 [MW Sync] Navigating to User Management…');

    // Try direct navigation
    try {
        await page.goto(`${MW_HOST}/AccountsList.aspx`, { waitUntil: 'load', timeout: 20_000 });
        if (!page.url().toLowerCase().includes('default.aspx')) {
            console.log('   ✅ [MW Sync] Reached AccountsList directly.');
            return;
        }
    } catch { /* fall through to frameset approach */ }

    // Frameset approach — find User Management link in any frame
    await page.goto(`${MW_HOST}/Store.aspx`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    for (const frame of page.frames()) {
        const navSelectors = [
            'a:has-text("User Management")',
            'span:has-text("User Management")',
        ];
        for (const sel of navSelectors) {
            const el = frame.locator(sel).first();
            if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                await el.click();
                await page.waitForTimeout(2000);
                console.log('   ✅ [MW Sync] Clicked User Management in sidebar.');
                return;
            }
        }
    }

    throw new Error('[MW Sync] Could not navigate to User Management');
}

// ─── Create player ────────────────────────────────────────────
async function createPlayerOnMW(page, username, password) {
    await goToUserManagement(page);

    // Get AccountsList frame
    let listFrame;
    try {
        listFrame = await waitForFrame(page, 'AccountsList', 10_000);
    } catch {
        listFrame = page.mainFrame();
    }

    // Click Create Player button
    const createBtnSelectors = [
        'input[value="Create Player"]',
        'button:has-text("Create Player")',
        'a:has-text("Create Player")',
    ];

    let btnClicked = false;
    for (const frame of [listFrame, ...page.frames()]) {
        for (const sel of createBtnSelectors) {
            const el = frame.locator(sel).first();
            if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                await el.click({ force: true });
                btnClicked = true;
                console.log(`   ✅ [MW Sync] Clicked Create Player (${sel})`);
                break;
            }
        }
        if (btnClicked) break;
    }

    if (!btnClicked) {
        const triggered = await listFrame.evaluate(() => {
            if (typeof showDialog === 'function') { showDialog('6', 'Create Account', 900, 400, 1); return true; }
            return false;
        });
        if (!triggered) throw new Error('[MW Sync] Could not open Create Player dialog');
    }

    // Wait for form
    let createFrame = null;
    for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(500);
        createFrame = page.frames().find(f => f.url().includes('CreateAccount') || f.url().includes('create'));
        if (createFrame) break;
        const inDialog = await listFrame.evaluate(() => {
            const d = document.getElementById('DialogBySHFLayer');
            return d ? d.querySelectorAll('input[type="text"]').length : 0;
        }).catch(() => 0);
        if (inDialog >= 2) { createFrame = listFrame; break; }
    }

    if (!createFrame) {
        await page.screenshot({ path: path.join(OUTPUT, 'debug-no-dialog.png') });
        throw new Error('[MW Sync] Create Player dialog did not appear');
    }

    // Fill form
    const fillByHints = async (hints, value, label) => {
        for (const frame of [createFrame, ...page.frames()]) {
            for (const hint of hints) {
                const sel = `tr:has(td:has-text("${hint}")) input`;
                const el = frame.locator(sel).first();
                if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
                    await el.fill(value);
                    console.log(`   ✏️  [MW Sync] Filled "${label}"`);
                    return;
                }
            }
        }
        console.warn(`   ⚠️  [MW Sync] Could not fill "${label}"`);
    };

    await fillByHints(['Account', 'Username', 'User Name'],         username, 'Account');
    await fillByHints(['Login password', 'Password'],               password, 'Password');
    await fillByHints(['Confirm password', 'Confirm Password'],     password, 'Confirm Password');

    // Submit
    const submitSelectors = ['input[value="Create Player"]', 'button:has-text("Create Player")', 'input[value="Submit"]', 'input[value="Save"]'];
    for (const sel of submitSelectors) {
        const el = createFrame.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
            await el.click({ force: true });
            break;
        }
    }

    await page.waitForTimeout(2000);
    await page.evaluate(() => {
        if (typeof CloseDiaLog === 'function') CloseDiaLog();
        const ov = document.getElementById('DialogBySHFLayer');
        if (ov) ov.style.display = 'none';
    }).catch(() => {});

    console.log(`✅ [MW Sync] Player "${username}" created on MilkyWay.`);
}

// ─── Public API ───────────────────────────────────────────────
export async function syncCreatePlayer(username, password = 'Players@123') {
    if (!MW_USER || !MW_PASS) {
        return { ok: false, error: 'MW credentials not configured' };
    }

    try {
        const page = await getBrowser();
        if (!loggedIn) await login(page);

        // Verify session still valid
        const currentUrl = page.url().toLowerCase();
        if (currentUrl.includes('default.aspx')) {
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
        console.log('🔥 [MW Sync] Session pre-warmed.');
    } catch (err) {
        console.warn(`⚠️  [MW Sync] Warm-up failed (will retry on first use): ${err.message}`);
        loggedIn = false;
        mwPage   = null;
    }
}
