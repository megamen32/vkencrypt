// E2E-тест против настоящего VK. Грузит куки из .secrets, открывает
// реальный чат, проверяет, что userscript встал и нарисовал кнопки.
//
// Запускается ТОЛЬКО с RUN_LIVE=1, чтобы случайно не дёрнуть прод.
//   RUN_LIVE=1 npm run test:live
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(__dirname, '..', '..', '.secrets');
const CHAT_URL = 'https://web.vk.me/convo/-239277144?entrypoint=list_all';

const RUN_LIVE = !!process.env.RUN_LIVE;
console.log('[live-vk.spec.js] RUN_LIVE =', RUN_LIVE);

(RUN_LIVE ? test.describe : test.describe.skip)('live VK с куками из .secrets', () => {
    test('userscript грузится и рисует кнопки в реальном чате', async ({ browser }) => {
        if (!fs.existsSync(SECRETS_PATH)) {
            console.log('SKIP: нет .secrets');
            return;
        }

        const raw = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
        const cookies = raw.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.hostOnly ? c.domain : '.' + c.domain.replace(/^\.+/, ''),
            path: c.path || '/',
            expires: c.expirationDate > 0 ? Math.floor(c.expirationDate) : -1,
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            sameSite: c.sameSite === 'no_restriction' ? 'None' : 'Lax',
        }));

        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        await context.addCookies(cookies);

        const userScriptPath = path.join(__dirname, '..', '..', 'extension', 'vkencrypt.user.js');
        await context.addInitScript({ path: userScriptPath });

        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));

        await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);

        const url = page.url();
        console.log('URL after navigation:', url);

        const hasComposer = await page.locator('.ComposerInput__input, .im-editable[contenteditable="true"]').count() > 0;
        console.log('has composer:', hasComposer);

        if (!hasComposer) {
            console.log('SKIP: composer не найден, редирект на логин или диалог не открыт');
            await context.close();
            return;
        }

        await expect(page.locator('#vk-p2p-enc-btn')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#vk-p2p-key-btn')).toBeVisible({ timeout: 5000 });

        expect(errors, errors.join('\n')).toEqual([]);

        await context.close();
    });
});
