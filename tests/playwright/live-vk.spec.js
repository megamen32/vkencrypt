// E2E-тест против настоящего VK. Грузит куки из VK_LIVE_COOKIES или .secrets, открывает
// реальный чат, проверяет, что userscript встал и нарисовал кнопки.
//
// Запускается ТОЛЬКО с RUN_LIVE=1, чтобы случайно не дёрнуть прод.
//   RUN_LIVE=1 npm run test:live
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(__dirname, '..', '..', '.secrets');
const CHAT_URL = 'https://web.vk.me/convo/-239277144?entrypoint=list_all';
const COMPOSER_SELECTOR = [
    '.ComposerInput__input',
    '.im-editable[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
].join(', ');

const RUN_LIVE = !!process.env.RUN_LIVE;
console.log('[live-vk.spec.js] RUN_LIVE =', RUN_LIVE);

function parseJsonCookies(raw) {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
        throw new Error('JSON cookies must be an array');
    }

    return parsed.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.hostOnly ? c.domain : '.' + String(c.domain || '').replace(/^\.+/, ''),
        path: c.path || '/',
        expires: c.expirationDate > 0 ? Math.floor(c.expirationDate) : -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : 'Lax',
    }));
}

function parseNetscapeCookies(raw) {
    return raw.split(/\r?\n/).flatMap(originalLine => {
        let line = originalLine.trim();

        if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) {
            return [];
        }

        let httpOnly = false;
        if (line.startsWith('#HttpOnly_')) {
            httpOnly = true;
            line = line.slice('#HttpOnly_'.length);
        }

        const parts = line.split(/\t+/);
        if (parts.length < 7) {
            return [];
        }

        const [domain, , cookiePath, secure, expires, name, ...valueParts] = parts;

        return [{
            name,
            value: valueParts.join('\t'),
            domain,
            path: cookiePath || '/',
            expires: Number(expires) || -1,
            httpOnly,
            secure: secure === 'TRUE',
            sameSite: 'Lax',
        }];
    });
}

function loadCookies() {
    const envCookies = process.env.VK_LIVE_COOKIES;
    const raw = envCookies || (fs.existsSync(SECRETS_PATH) ? fs.readFileSync(SECRETS_PATH, 'utf8') : '');

    if (!raw.trim()) {
        return null;
    }

    const trimmed = raw.trim();
    const cookies = trimmed.startsWith('[')
        ? parseJsonCookies(trimmed)
        : parseNetscapeCookies(trimmed);

    if (!cookies.length) {
        throw new Error('No cookies parsed from VK_LIVE_COOKIES/.secrets');
    }

    return {
        cookies,
        source: envCookies ? 'VK_LIVE_COOKIES' : '.secrets',
    };
}

(RUN_LIVE ? test.describe : test.describe.skip)('live VK с реальными cookies', () => {
    test('userscript грузится и рисует кнопки в реальном чате', async ({ browser }) => {
        const loaded = loadCookies();

        if (!loaded) {
            console.log('SKIP: нет VK_LIVE_COOKIES или .secrets');
            return;
        }

        const { cookies, source } = loaded;
        console.log(`cookies source: ${source}, count: ${cookies.length}`);

        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        await context.addCookies(cookies);

        const userScriptPath = path.join(__dirname, '..', '..', 'extension', 'vkencrypt.user.js');
        const userScript = fs.readFileSync(userScriptPath, 'utf8');

        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));

        await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

        const url = page.url();
        console.log('URL after navigation:', url);

        const hasComposer = await page.locator(COMPOSER_SELECTOR).count() > 0;
        console.log('has composer:', hasComposer);
        expect(hasComposer, `composer не найден; URL after navigation: ${url}`).toBe(true);

        await page.evaluate(code => {
            const store = new Map();
            window.GM_getValue = (key, fallback) => store.has(key) ? store.get(key) : fallback;
            window.GM_setValue = (key, value) => { store.set(key, value); };
            window.GM_deleteValue = key => { store.delete(key); };
            new Function(code)();
        }, userScript);

        await expect(page.locator('#vk-p2p-enc-btn')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#vk-p2p-key-btn')).toBeVisible({ timeout: 5000 });

        expect(errors, errors.join('\n')).toEqual([]);

        await context.close();
    });
});
