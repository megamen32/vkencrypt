// Тесты userscript'а в моке VK-чата. Без сети, без Tampermonkey —
// userscript грузится через page.evaluate с стабами GM_*.
const { test, expect } = require('@playwright/test');
const {
    openMockChat,
} = require('./helpers');

test.beforeEach(async ({ page }) => {
    await openMockChat(page);
});

test('init: скрипт грузится, рисует кнопки в поле ввода', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
    });

    await expect(page.locator('#vk-p2p-enc-btn')).toBeVisible();
    await expect(page.locator('#vk-p2p-key-btn')).toBeVisible();

    expect(errors, errors.join('\n')).toEqual([]);
});
