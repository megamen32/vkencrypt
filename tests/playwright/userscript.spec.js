// Тесты userscript'а в моке VK-чата. Без сети, без Tampermonkey —
// userscript грузится через page.evaluate с стабами GM_*.
const { test, expect } = require('@playwright/test');
const {
    openMockChat,
    openModernWebVkChat,
} = require('./helpers');
const crypto = require('crypto');

const KDF_SALT = 'vk-p2p-aes-gcm-v1';
const KDF_ITERATIONS = 250_000;
const IV_LEN = 12;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const EMOJI_ALPHABET = [
    '😀','😁','😂','🤣','😃','😄','😅','😆',
    '😉','😊','😋','😎','😍','😘','🥰','😗',
    '😙','😚','🙂','🤗','🤩','🤔','🤨','😐',
    '😑','😶','🙄','😏','😣','😥','😮','🤐',
    '😯','😪','😫','🥱','😴','😌','😛','😜',
    '😝','🤤','😒','😓','😔','😕','🙃','🤑',
    '😲','😡','🤬','😖','😞','😟','😤','😢',
    '😭','😦','😧','😨','😩','🤯','😬','😰'
];
const EMOJI_PAD = '🟰';
const EMOJI_MARKER = 'emj.';

function deriveDerivedKeys(seed) {
    const derived = crypto.pbkdf2Sync(seed, KDF_SALT, KDF_ITERATIONS, 128, 'sha256');
    return {
        k1: derived.subarray(0, 32).toString('hex'),
        k2: derived.subarray(32, 64).toString('hex'),
        k3: derived.subarray(64, 96).toString('hex'),
        k4: derived.subarray(96, 128).toString('hex'),
    };
}

function encryptForEmoji(plainText, keyHex) {
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const b64 = Buffer.concat([iv, ct, tag]).toString('base64');

    let out = '';
    for (const ch of b64) {
        if (ch === '=') {
            out += EMOJI_PAD;
            continue;
        }

        const idx = BASE64_ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error(`Invalid base64 char: ${ch}`);
        out += EMOJI_ALPHABET[idx];
    }

    return EMOJI_MARKER + out;
}

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

test('emoji incoming: emj.-шифротекст расшифровывается без atob error', async ({ page }) => {
    const seed = 'очень длинная секретная фраза для emoji теста';
    const derived = deriveDerivedKeys(seed);
    const cipherText = encryptForEmoji('Привет, emoji!', derived.k1);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
    });

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify({
                autoEncrypt: false,
                saveDerivedKeys: true,
                decryptIncoming: true,
                emojiCipher: true,
            }),
        },
        body: `
            <div class="ConvoMessage__text">ENC[k1:${cipherText}]</div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">
                    <i class="ConvoComposer__buttonIcon ConvoComposer__buttonIcon--submit">→</i>
                </button>
            </div>
        `,
    });

    await expect(page.locator('.vk-dec-content')).toHaveText('Привет, emoji!');
    expect(errors, errors.join('\n')).toEqual([]);
});
