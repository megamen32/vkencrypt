// Конфиг для live-теста: прогоняет ТОЛЬКО live-vk.spec.js. Без него
// дефолтный `playwright test` тесты-заглушки в live-vk.spec.js всё
// равно скипнулись бы (RUN_LIVE != 1), но так не теряем даже сам факт
// их существования в отчёте.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/playwright',
    testMatch: ['**/live-vk.spec.js'],
    fullyParallel: false,
    retries: 0,
    workers: 1,
    reporter: [['list']],
    use: {
        headless: true,
        viewport: { width: 1280, height: 800 },
        actionTimeout: 8000,
        navigationTimeout: 30000,
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
});
