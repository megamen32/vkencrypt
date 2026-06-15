// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/playwright',
    // live-vk.spec.js по умолчанию skip'ается изнутри (RUN_LIVE=1) и
    // не должен валить дефолтный прогон, поэтому исключаем его здесь.
    testIgnore: ['**/live-vk.spec.js'],
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 1,
    reporter: [['list'], ['html', { open: 'never' }]],

    use: {
        headless: true,
        viewport: { width: 1280, height: 800 },
        actionTimeout: 5000,
        navigationTimeout: 15000,
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
    },

    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
});
