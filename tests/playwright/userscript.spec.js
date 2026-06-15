// Тесты userscript'а в моке VK-чата. Без сети, без Tampermonkey —
// userscript грузится через page.evaluate с стабами GM_*.
const { test, expect } = require('@playwright/test');
const {
    openMockChat,
    openModernWebVkChat,
} = require('./helpers');

test('init: скрипт грузится, рисует кнопки в старом поле ввода', async ({ page }) => {
    await openMockChat(page);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
    });

    await expect(page.locator('#vk-p2p-enc-btn')).toBeVisible();
    await expect(page.locator('#vk-p2p-key-btn')).toBeVisible();

    expect(errors, errors.join('\n')).toEqual([]);
});

test('init: скрипт рисует кнопки в web.vk.me composer без старых классов', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
    });

    await openModernWebVkChat(page);

    await expect(page.locator('#vk-p2p-enc-btn')).toBeVisible();
    await expect(page.locator('#vk-p2p-key-btn')).toBeVisible();

    const controlsParent = await page.locator('#vk-p2p-enc-controls').evaluate(el => el.parentElement?.className || '');
    expect(controlsParent).toContain('vk-modern-composer');

    expect(errors, errors.join('\n')).toEqual([]);
});
