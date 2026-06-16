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
const CYRILLIC_ALPHABET = [
    'А','Б','В','Г','Д','Е','Ж','З',
    'И','Й','К','Л','М','Н','О','П',
    'Р','С','Т','У','Ф','Х','Ц','Ч',
    'Ш','Щ','Ъ','Ы','Ь','Э','Ю','Я',
    'а','б','в','г','д','е','ж','з',
    'и','й','к','л','м','н','о','п',
    'р','с','т','у','ф','х','ц','ч',
    'ш','щ','ъ','ы','ь','э','ю','я',
];
const FORMAT_START = '𓁗';
const FORMAT_MID = 'Ⰴ';
const FORMAT_PAYLOAD = 'Ⱑ';
const MEDIA_CONTAINER_MAGIC = 'VKEM1';
const CODEC_MARKERS = {
    base64: '𐌁',
    emoji: '𐌄',
    cyrillic: '𐌓',
};

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

    return out.replace(/🟰+$/u, '');
}

function makeBaseSettings(extra = {}) {
    return {
        autoEncrypt: false,
        saveDerivedKeys: true,
        autoDecrypt: true,
        emojiCipher: true,
        cipherCodec: 'emoji',
        ...extra,
    };
}

async function setComposerText(page, text) {
    await page.locator('[contenteditable="true"]').first().evaluate((el, value) => {
        el.focus();
        el.innerText = value;
        el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: value,
        }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
}

async function getComposerText(page) {
    return page.locator('[contenteditable="true"]').first().evaluate(el => el.innerText.trim());
}

function renderEmojiAsImages(payload) {
    return Array.from(payload).map(ch => {
        if (ch === '🟰') {
            return '🟰';
        }

        return `<img src=\"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==\" alt=\"${ch}\" class=\"Emoji\">`;
    }).join('');
}

function encryptBinaryPayload(buffer, keyHex) {
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ct, tag]);
}

function buildEncryptedMediaContainer({ keyId = 'k1', keyHex, mime, originalName, body }) {
    const payload = encryptBinaryPayload(body, keyHex);
    const meta = Buffer.from(JSON.stringify({
        version: 1,
        keyId,
        mime,
        originalName,
        originalSize: body.length,
    }), 'utf8');
    const metaLen = Buffer.alloc(4);
    metaLen.writeUInt32BE(meta.length, 0);
    return Buffer.concat([
        Buffer.from(MEDIA_CONTAINER_MAGIC, 'utf8'),
        metaLen,
        meta,
        payload,
    ]);
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

test('composer controls: настройки после загрузки файла, замок перед emoji', async ({ page }) => {
    await openMockChat(page, {
        url: 'https://example.com',
        body: `
            <div class="ConvoComposer__inputPanel">
                <div class="DropdownReforged ConvoComposer__clip DropdownReforged--closed">
                    <div class="DropdownReforged__trigger">
                        <button class="ConvoComposer__button" aria-label="Загрузить файл">+</button>
                    </div>
                </div>
                <div role="presentation" class="ComposerInput ConvoComposer__inputWrapper">
                    <div role="presentation">
                        <span contenteditable="true"
                              class="ComposerInput__input ConvoComposer__input ComposerInput__input--fixed"
                              data-placeholder="Сообщение"
                              inputmode="text"
                              translate="no"
                              role="textbox"
                              aria-multiline="true"
                              aria-label="Сообщение">1</span>
                    </div>
                </div>
                <button class="ConvoComposer__button" aria-label="Выбрать эмодзи">☺</button>
                <div class="DropdownReforged DropdownReforged--closed">
                    <div class="DropdownReforged__trigger">
                        <button class="ConvoComposer__button ConvoComposer__sendButton--submit" aria-label="Отправить сообщение">→</button>
                    </div>
                </div>
            </div>
        `,
    });

    const wrapperParent = await page.locator('#vk-p2p-enc-controls').evaluate(el => el.parentElement?.className || '');
    expect(wrapperParent).toContain('ConvoComposer__inputPanel');

    const order = await page.locator('.ConvoComposer__inputPanel').evaluate(panel => {
        const children = Array.from(panel.children).map(el => ({
            id: el.id || '',
            className: el.className || '',
            hasUploadButton: el.matches?.('[aria-label*="Загрузить файл"]') || !!el.querySelector?.('[aria-label*="Загрузить файл"]'),
            hasInput: !!el.querySelector?.('[contenteditable="true"]'),
            hasEmojiButton: el.matches?.('[aria-label*="эмодзи"]') || !!el.querySelector?.('[aria-label*="эмодзи"]'),
            hasSendButton: el.matches?.('[aria-label*="Отправить"]') || !!el.querySelector?.('[aria-label*="Отправить"]'),
        }));
        return children;
    });

    const keyIndex = order.findIndex(item => item.id === 'vk-p2p-key-controls');
    const controlsIndex = order.findIndex(item => item.id === 'vk-p2p-enc-controls');
    const uploadIndex = order.findIndex(item => item.hasUploadButton);
    const inputIndex = order.findIndex(item => item.hasInput);
    const emojiIndex = order.findIndex(item => item.hasEmojiButton);
    const sendIndex = order.findIndex(item => item.hasSendButton);

    expect(keyIndex).toBeGreaterThan(uploadIndex);
    expect(keyIndex).toBeLessThan(inputIndex);
    expect(controlsIndex).toBeGreaterThanOrEqual(0);
    expect(controlsIndex).toBeGreaterThan(inputIndex);
    expect(controlsIndex).toBeLessThan(emojiIndex);
    expect(sendIndex).toBeGreaterThan(emojiIndex);

    await expect(page.locator('.DropdownReforged__trigger #vk-p2p-key-controls')).toHaveCount(0);
    await expect(page.locator('.DropdownReforged__trigger #vk-p2p-enc-controls')).toHaveCount(0);
});

test('composer controls: при autoEncrypt скрывается весь wrapper замка без пустого места', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для скрытия замка');

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoEncrypt: true })),
        },
        body: `
            <div class="ConvoComposer__inputPanel">
                <div class="DropdownReforged ConvoComposer__clip DropdownReforged--closed">
                    <div class="DropdownReforged__trigger">
                        <button class="ConvoComposer__button" aria-label="Загрузить файл">+</button>
                    </div>
                </div>
                <div role="presentation" class="ComposerInput ConvoComposer__inputWrapper">
                    <div role="presentation">
                        <span contenteditable="true"
                              class="ComposerInput__input ConvoComposer__input ComposerInput__input--fixed"
                              role="textbox"
                              aria-multiline="true"
                              aria-label="Сообщение">1</span>
                    </div>
                </div>
                <button class="ConvoComposer__button" aria-label="Выбрать эмодзи">☺</button>
                <div class="DropdownReforged DropdownReforged--closed">
                    <div class="DropdownReforged__trigger">
                        <button class="ConvoComposer__button ConvoComposer__sendButton--submit" aria-label="Отправить сообщение">→</button>
                    </div>
                </div>
            </div>
        `,
    });

    await expect(page.locator('#vk-p2p-enc-controls')).toBeHidden();

    const order = await page.locator('.ConvoComposer__inputPanel').evaluate(panel => {
        return Array.from(panel.children)
            .filter(el => getComputedStyle(el).display !== 'none')
            .map(el => ({
                id: el.id || '',
                hasInput: !!el.querySelector?.('[contenteditable="true"]'),
                hasEmojiButton: el.matches?.('[aria-label*="эмодзи"]') || !!el.querySelector?.('[aria-label*="эмодзи"]'),
            }));
    });

    const keyIndex = order.findIndex(item => item.id === 'vk-p2p-key-controls');
    const inputIndex = order.findIndex(item => item.hasInput);
    const emojiIndex = order.findIndex(item => item.hasEmojiButton);
    const encIndex = order.findIndex(item => item.id === 'vk-p2p-enc-controls');

    expect(encIndex).toBe(-1);
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    expect(keyIndex).toBeLessThan(inputIndex);
    expect(keyIndex).toBeLessThan(emojiIndex);
});

test('share instruction: пункт меню вставляет plaintext-инструкцию без шифрования', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для инструкции');
    let sentText = '';

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoEncrypt: true })),
        },
        body: `
            <div class="ConvoComposer__inputPanel">
                <button class="ConvoComposer__button" aria-label="Загрузить файл">+</button>
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button" aria-label="Выбрать эмодзи">☺</button>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await page.locator('[aria-label="Отправить"]').evaluate(button => {
        button.addEventListener('click', () => {
            window.__sentText = document.querySelector('[contenteditable="true"]').innerText.trim();
        });
    });

    await page.locator('#vk-p2p-key-btn').click();
    await page.getByRole('button', { name: /Скинуть инструкцию/i }).click();
    await expect(page.locator('#vk-p2p-share-install-url')).toBeChecked();
    await expect(page.locator('#vk-p2p-share-cyberchef')).toBeChecked();
    await page.locator('#vk-p2p-share-send').click();

    sentText = await page.evaluate(() => window.__sentText || '');

    expect(sentText).toContain('VKEncrypt');
    expect(sentText).toContain('https://github.com/megamen32/vkencrypt#readme');
    expect(sentText).toContain('CyberChef');
    expect(sentText).toContain('Ключ я отправлю отдельно');
    expect(sentText).not.toMatch(/^𓁗/u);
});

test('media upload: image/audio/video подменяются на encrypted .vke до upload-listener страницы', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для media upload');

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ encryptMediaUploads: true })),
        },
        body: `
            <div class="ConvoComposer__inputPanel">
                <button class="ConvoComposer__button" aria-label="Загрузить файл">+</button>
                <input id="vk-media-input" type="file" accept="image/*,audio/*,video/*" multiple>
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button" aria-label="Выбрать эмодзи">☺</button>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await page.locator('#vk-media-input').evaluate(input => {
        input.addEventListener('change', async () => {
            window.__mediaUploadInfo = await Promise.all(Array.from(input.files).map(async file => ({
                name: file.name,
                type: file.type,
                size: file.size,
                prefix: Array.from(new Uint8Array(await file.slice(0, 5).arrayBuffer())),
            })));
        });
    });

    await page.locator('#vk-media-input').setInputFiles([
        {
            name: 'photo.png',
            mimeType: 'image/png',
            buffer: Buffer.from('not-a-real-png'),
        },
        {
            name: 'voice.ogg',
            mimeType: 'audio/ogg',
            buffer: Buffer.from('not-a-real-ogg'),
        },
        {
            name: 'movie.mp4',
            mimeType: 'video/mp4',
            buffer: Buffer.from('not-a-real-mp4'),
        },
    ]);

    await expect.poll(async () => page.evaluate(() => window.__mediaUploadInfo || null)).toMatchObject({
        0: { name: 'photo.png.vke', type: 'application/octet-stream' },
        1: { name: 'voice.ogg.vke', type: 'application/octet-stream' },
        2: { name: 'movie.mp4.vke', type: 'application/octet-stream' },
    });

    const info = await page.evaluate(() => window.__mediaUploadInfo);
    info.forEach(item => {
        expect(item.prefix).toEqual(Array.from(Buffer.from(MEDIA_CONTAINER_MAGIC, 'utf8')));
    });
});

test('incoming media: .vke attachment auto-decrypts image and exposes download', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для incoming media');
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2QAAAAASUVORK5CYII=',
        'base64'
    );
    const container = buildEncryptedMediaContainer({
        keyHex: derived.k1,
        mime: 'image/png',
        originalName: 'cat.png',
        body: pngBytes,
    });
    const dataUrl = `data:application/octet-stream;base64,${container.toString('base64')}`;

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: true, encryptMediaUploads: true })),
        },
        body: `
            <div class="ConvoMessage__text">
                <a id="vk-media-link" href="${dataUrl}">cat.png.vke</a>
            </div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-p2p-media-preview img')).toBeVisible();
    await expect(page.locator('.vk-p2p-media-download')).toHaveAttribute('download', 'cat.png');
    await expect(page.locator('.vk-p2p-media-meta')).toContainText('cat.png');
    await expect(page.locator('#vk-media-link')).toHaveText('cat.png');
    await expect(page.locator('#vk-media-link')).toHaveAttribute('download', 'cat.png');
});

test('incoming media: m.vk AttachDoc card с .vke headline тоже расшифровывается', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для attachdoc');
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2QAAAAASUVORK5CYII=',
        'base64'
    );
    const container = buildEncryptedMediaContainer({
        keyHex: derived.k1,
        mime: 'image/png',
        originalName: 'attachdoc.png',
        body: pngBytes,
    });
    const dataUrl = `data:application/octet-stream;base64,${container.toString('base64')}`;

    await openMockChat(page, {
        url: 'https://m.vk.com/mail/convo/1',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: true, encryptMediaUploads: true })),
        },
        body: `
            <article class="ConvoMessage">
                <div class="Attachments ConvoMessage__attachments ConvoMessage__attachments--withoutMarginTop">
                    <a id="vk-attachdoc-link" class="AttachDoc" href="${dataUrl}" target="_blank" rel="noopener noreferrer">
                        <div class="AttachmentCell AttachmentCell--clickable">
                            <div class="AttachmentCell__infoBlockContainer">
                                <div class="AttachmentCell__infoBlock">
                                    <h4 class="AttachmentCell__headline">attachdoc.png.vke</h4>
                                    <span class="AttachmentCell__footnote">VKE ᐧ 61 KB</span>
                                </div>
                            </div>
                        </div>
                    </a>
                </div>
            </article>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-p2p-media-preview img')).toBeVisible();
    await expect(page.locator('#vk-attachdoc-link .AttachmentCell__headline')).toHaveText('attachdoc.png');
    await expect(page.locator('#vk-attachdoc-link')).toHaveAttribute('download', 'attachdoc.png');
});

test('incoming media: m.vk AttachDoc card с audio .vke даёт audio preview и download', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для attachdoc audio');
    const audioBytes = Buffer.from('OggSfake-audio', 'utf8');
    const container = buildEncryptedMediaContainer({
        keyHex: derived.k1,
        mime: 'audio/ogg',
        originalName: 'attachdoc-voice.ogg',
        body: audioBytes,
    });
    const dataUrl = `data:application/octet-stream;base64,${container.toString('base64')}`;

    await openMockChat(page, {
        url: 'https://m.vk.com/mail/convo/1',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: true, encryptMediaUploads: true })),
        },
        body: `
            <article class="ConvoMessage">
                <div class="Attachments ConvoMessage__attachments ConvoMessage__attachments--withoutMarginTop">
                    <a id="vk-attachdoc-audio-link" class="AttachDoc" href="${dataUrl}" target="_blank" rel="noopener noreferrer">
                        <div class="AttachmentCell AttachmentCell--clickable">
                            <div class="AttachmentCell__infoBlockContainer">
                                <div class="AttachmentCell__infoBlock">
                                    <h4 class="AttachmentCell__headline">attachdoc-voice.ogg.vke</h4>
                                    <span class="AttachmentCell__footnote">VKE ᐧ 8 KB</span>
                                </div>
                            </div>
                        </div>
                    </a>
                </div>
            </article>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-p2p-media-preview audio')).toBeVisible();
    await expect(page.locator('#vk-attachdoc-audio-link .AttachmentCell__headline')).toHaveText('attachdoc-voice.ogg');
    await expect(page.locator('#vk-attachdoc-audio-link')).toHaveAttribute('download', 'attachdoc-voice.ogg');
});

test('incoming media: m.vk AttachDoc card с video .vke даёт video preview и download', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для attachdoc video');
    const videoBytes = Buffer.from('fake-video-binary', 'utf8');
    const container = buildEncryptedMediaContainer({
        keyHex: derived.k1,
        mime: 'video/mp4',
        originalName: 'attachdoc-video.mp4',
        body: videoBytes,
    });
    const dataUrl = `data:application/octet-stream;base64,${container.toString('base64')}`;

    await openMockChat(page, {
        url: 'https://m.vk.com/mail/convo/1',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: true, encryptMediaUploads: true })),
        },
        body: `
            <article class="ConvoMessage">
                <div class="Attachments ConvoMessage__attachments ConvoMessage__attachments--withoutMarginTop">
                    <a id="vk-attachdoc-video-link" class="AttachDoc" href="${dataUrl}" target="_blank" rel="noopener noreferrer">
                        <div class="AttachmentCell AttachmentCell--clickable">
                            <div class="AttachmentCell__infoBlockContainer">
                                <div class="AttachmentCell__infoBlock">
                                    <h4 class="AttachmentCell__headline">attachdoc-video.mp4.vke</h4>
                                    <span class="AttachmentCell__footnote">VKE ᐧ 14 KB</span>
                                </div>
                            </div>
                        </div>
                    </a>
                </div>
            </article>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-p2p-media-preview video')).toBeVisible();
    await expect(page.locator('#vk-attachdoc-video-link .AttachmentCell__headline')).toHaveText('attachdoc-video.mp4');
    await expect(page.locator('#vk-attachdoc-video-link')).toHaveAttribute('download', 'attachdoc-video.mp4');
});

test('incoming media: выключение авторасшифровки убирает preview обратно', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для media toggle off');
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2QAAAAASUVORK5CYII=',
        'base64'
    );
    const container = buildEncryptedMediaContainer({
        keyHex: derived.k1,
        mime: 'image/png',
        originalName: 'toggle.png',
        body: pngBytes,
    });
    const dataUrl = `data:application/octet-stream;base64,${container.toString('base64')}`;

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: true, encryptMediaUploads: true })),
        },
        body: `
            <div class="ConvoMessage__text">
                <a href="${dataUrl}">toggle.png.vke</a>
            </div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-p2p-media-preview img')).toBeVisible();

    await page.locator('#vk-p2p-key-btn').click();
    await page.getByRole('button', { name: /Авто-расшифровка: включена/i }).click();

    await expect(page.locator('.vk-p2p-media-preview img')).toHaveCount(0);
    await expect(page.locator('.vk-p2p-media-download')).toBeHidden();
    await expect(page.locator('.ConvoMessage__text a').first()).toHaveText('toggle.png.vke');
});

test('incoming media: .vke attachment auto-decrypts audio and exposes controls', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для incoming audio');
    const audioBytes = Buffer.from('OggSfake-audio', 'utf8');
    const container = buildEncryptedMediaContainer({
        keyHex: derived.k1,
        mime: 'audio/ogg',
        originalName: 'voice.ogg',
        body: audioBytes,
    });
    const dataUrl = `data:application/octet-stream;base64,${container.toString('base64')}`;

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: true, encryptMediaUploads: true })),
        },
        body: `
            <div class="ConvoMessage__text">
                <a href="${dataUrl}">voice.ogg.vke</a>
            </div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-p2p-media-preview audio')).toBeVisible();
    await expect(page.locator('.vk-p2p-media-download')).toHaveAttribute('download', 'voice.ogg');
});

test('incoming media: повторная расшифровка использует cache без повторного fetch', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для media cache');
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk2QAAAAASUVORK5CYII=',
        'base64'
    );
    const container = buildEncryptedMediaContainer({
        keyHex: derived.k1,
        mime: 'image/png',
        originalName: 'cache.png',
        body: pngBytes,
    });
    const dataUrl = `data:application/octet-stream;base64,${container.toString('base64')}`;

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: false, encryptMediaUploads: true })),
        },
        body: `
            <div class="ConvoMessage__text">
                <a href="${dataUrl}">cache.png.vke</a>
            </div>
            <div class="ConvoMessage__text">
                <a href="${dataUrl}">cache-copy.png.vke</a>
            </div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await page.evaluate(() => {
        const originalFetch = window.fetch.bind(window);
        window.__mediaFetchCount = 0;
        window.fetch = async (...args) => {
            const url = String(args[0]);
            if (url.startsWith('data:application/octet-stream')) {
                window.__mediaFetchCount += 1;
            }
            return originalFetch(...args);
        };
    });

    await page.locator('.vk-p2p-media-btn').first().click();
    await expect(page.locator('.vk-p2p-media-preview img').first()).toBeVisible();
    await page.locator('.vk-p2p-media-btn').nth(1).click();
    await expect(page.locator('.vk-p2p-media-preview img').nth(1)).toBeVisible();

    await expect.poll(async () => page.evaluate(() => window.__mediaFetchCount)).toBe(1);
});

test('incoming media: Safari cross-origin auto decrypt не уходит в бесконечный цикл ошибок', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для safari media');

    await openMockChat(page, {
        url: 'https://web.vk.me/convo/1',
        disableGMXmlhttpRequest: true,
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: true, encryptMediaUploads: true })),
        },
        body: `
            <article class="ConvoMessage">
                <div class="Attachments ConvoMessage__attachments ConvoMessage__attachments--withoutMarginTop">
                    <a id="vk-safari-media-link" class="AttachDoc" href="https://psv4.userapi.com/s/v1/d2/test/post_1_png.vke" target="_blank" rel="noopener noreferrer">
                        <div class="AttachmentCell AttachmentCell--clickable">
                            <div class="AttachmentCell__infoBlockContainer">
                                <div class="AttachmentCell__infoBlock">
                                    <h4 class="AttachmentCell__headline">post_1_png.vke</h4>
                                    <span class="AttachmentCell__footnote">VKE ᐧ 1.6 MB</span>
                                </div>
                            </div>
                        </div>
                    </a>
                </div>
            </article>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-p2p-media-error')).toContainText('Safari Userscripts не дал GM_xmlhttpRequest');
    await expect(page.locator('.vk-p2p-media-btn')).toBeVisible();

    const state = await page.locator('.vk-p2p-media-box').evaluate(el => ({
        autoTried: el.dataset.vkP2PAutoTried || null,
        decoded: el.dataset.vkP2PDecoded || null,
    }));

    expect(state.autoTried).toBe('true');
    expect(state.decoded).toBeNull();

    await page.evaluate(() => {
        const marker = document.createElement('div');
        marker.textContent = 'mutation';
        document.body.appendChild(marker);
    });

    await page.waitForTimeout(50);
    await expect(page.locator('.vk-p2p-media-error')).toContainText('Safari Userscripts не дал GM_xmlhttpRequest');
    await expect(page.locator('.vk-p2p-media-box')).toHaveCount(1);
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
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
        body: `
            <div class="ConvoMessage__text">𓁗1Ⰴ𐌄Ⱑ${cipherText}</div>
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

test('emoji incoming: VK emoji images в сообщении корректно собираются из alt и расшифровываются', async ({ page }) => {
    const seed = 'очень длинная секретная фраза для emoji img теста';
    const derived = deriveDerivedKeys(seed);
    const cipherText = encryptForEmoji('Привет, emoji img!', derived.k1);

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
    });

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
        body: `
            <div class="ConvoMessage__text">𓁗1Ⰴ𐌄Ⱑ${renderEmojiAsImages(cipherText)}</div>
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

    await expect(page.locator('.vk-dec-content')).toHaveText('Привет, emoji img!');
    expect(errors, errors.join('\n')).toEqual([]);
});

test('encrypt button: по умолчанию шифрует в короткий emoji-формат', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для короткого формата');

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
    });

    await setComposerText(page, 'Привет короткий формат');
    await page.locator('#vk-p2p-enc-btn').click();

    await expect.poll(async () => {
        return getComposerText(page);
    }).toMatch(/^𓁗1Ⰴ𐌄Ⱑ/u);
});

test('menu settings: dropdown переключает кодировку на русский алфавит', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для русского алфавита');

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
    });

    await page.locator('#vk-p2p-key-btn').click();
    await expect(page.locator('#vk-p2p-cipher-codec-select')).toBeVisible();
    await page.locator('#vk-p2p-cipher-codec-select').selectOption('cyrillic');
    await page.keyboard.press('Escape');

    await setComposerText(page, 'Русский алфавит');
    await page.locator('#vk-p2p-enc-btn').click();

    await expect.poll(async () => getComposerText(page)).toMatch(/^𓁗1Ⰴ𐌓Ⱑ/u);
    const encrypted = await getComposerText(page);

    expect(encrypted).toMatch(/^𓁗1Ⰴ𐌓Ⱑ/u);

    const payload = encrypted.slice('𓁗1Ⰴ𐌓Ⱑ'.length);
    for (const ch of Array.from(payload)) {
        expect(CYRILLIC_ALPHABET.includes(ch)).toBe(true);
    }
});

test('auto decrypt off: шифротекст остаётся как есть для всех сообщений', async ({ page }) => {
    const seed = 'seed для отключенной авторасшифровки';
    const derived = deriveDerivedKeys(seed);
    const cipherText = encryptForEmoji('Не трогай меня', derived.k1);

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: false })),
        },
        body: `
            <div class="ConvoMessage__text">𓁗1Ⰴ𐌄Ⱑ${cipherText}</div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-dec-content')).toHaveCount(0);
    await expect(page.locator('.ConvoMessage__text')).toContainText('𓁗1Ⰴ𐌄Ⱑ');
});

test('auto decrypt toggle off: уже расшифрованные сообщения откатываются к шифру', async ({ page }) => {
    const seed = 'seed для toggle off restore';
    const derived = deriveDerivedKeys(seed);
    const cipherText = encryptForEmoji('Верни шифр назад', derived.k1);

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings({ autoDecrypt: true })),
        },
        body: `
            <div class="ConvoMessage__text">𓁗1Ⰴ𐌄Ⱑ${cipherText}</div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-dec-content')).toHaveText('Верни шифр назад');

    await page.locator('#vk-p2p-key-btn').click();
    await page.getByRole('button', { name: /Авто-расшифровка: включена/i }).click();

    await expect(page.locator('.ConvoMessage__text')).toContainText('𓁗1Ⰴ𐌄Ⱑ');
    await expect(page.locator('.vk-dec-content')).toHaveCount(0);
});

test('invalid new payload: похожий префикс не должен вызывать ошибку расшифровки', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для ложного совпадения');
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
    });

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_custom_keys_v1: JSON.stringify({
                asd: {
                    key: deriveDerivedKeys('custom-asd').k1,
                    label: 'asd',
                },
            }),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
        body: `
            <div class="ConvoMessage__text">𓁗asdⰄ𐌄Ⱑnot-really-encrypted</div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-dec-content')).toHaveCount(0);
    await expect(page.locator('.ConvoMessage__text')).toContainText('𓁗asdⰄ𐌄Ⱑnot-really-encrypted');
    expect(errors, errors.join('\n')).toEqual([]);
});

test('invalid new base64 payload: битый envelope не должен вызывать atob error', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для битого legacy');
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
    });

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
        body: `
            <div class="ConvoMessage__text">𓁗1Ⰴ𐌁Ⱑnot-base64!!!!</div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-dec-content')).toHaveCount(0);
    await expect(page.locator('.ConvoMessage__text')).toContainText('𓁗1Ⰴ𐌁Ⱑnot-base64!!!!');
    expect(errors, errors.join('\n')).toEqual([]);
});

test('decrypt error UI: исходный шифр остаётся, ошибка показывается отдельной строкой', async ({ page }) => {
    const validKey = deriveDerivedKeys('seed для шифрования').k1;
    const wrongSeed = deriveDerivedKeys('seed для красивой ошибки');
    const wrongCipher = encryptForEmoji('ошибка дешифровки', validKey);

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(wrongSeed),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
        body: `
            <div class="ConvoMessage__text">𓁗1Ⰴ𐌄Ⱑ${wrongCipher}</div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await expect(page.locator('.vk-dec-content')).toContainText('𓁗1Ⰴ𐌄Ⱑ');
    await expect(page.locator('.vk-dec-error')).toContainText('ошибка:');
});

test('toggle cipher: клик по [шифр] не пере-расшифровывает сообщение обратно', async ({ page }) => {
    const seed = 'seed для toggle';
    const derived = deriveDerivedKeys(seed);
    const cipherText = encryptForEmoji('Стабильный toggle', derived.k1);

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
        body: `
            <div class="ConvoMessage__text">𓁗1Ⰴ𐌄Ⱑ${cipherText}</div>
            <div class="ConvoComposer__inputPanel">
                <div class="ComposerInput">
                    <span contenteditable="true"
                          class="ComposerInput__input ConvoComposer__input"
                          role="textbox"
                          aria-multiline="true"></span>
                </div>
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic" aria-label="Отправить">→</button>
            </div>
        `,
    });

    await page.locator('.vk-dec-toggle').click();
    await page.waitForTimeout(50);
    await expect(page.locator('.vk-dec-content')).toContainText('𓁗1Ⰴ𐌄Ⱑ');
    await expect(page.locator('.vk-dec-toggle')).toHaveText('[текст]');
});

test('custom key modal: имя слота принимает кириллицу', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для модалки с кириллицей');

    await openMockChat(page, {
        url: 'https://example.com',
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
    });

    await page.locator('#vk-p2p-key-btn').click();
    await page.getByRole('button', { name: /Добавить пользовательский ключ/i }).click();

    await page.locator('#vk-p2p-custom-name').fill('рыба');
    await page.locator('#vk-p2p-custom-key').fill('секретное слово');
    await page.locator('#vk-p2p-custom-save').click();

    await expect(page.locator('.vk-p2p-overlay')).toHaveCount(0);
    await page.locator('#vk-p2p-key-btn').click();
    await expect(page.getByRole('button', { name: /^🔑 рыба \(секретное слово\)$/ })).toBeVisible();
});

test('mobile menu: окно настроек остаётся в пределах viewport и скроллится', async ({ page }) => {
    const derived = deriveDerivedKeys('seed для мобильного меню');
    const customKeys = {};
    for (let i = 0; i < 10; i += 1) {
        customKeys[`slot${i}`] = {
            key: deriveDerivedKeys(`custom-${i}`).k1,
            label: `label-${i}`,
        };
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await openMockChat(page, {
        gmSeed: {
            vk_p2p_derived_keys_v1: JSON.stringify(derived),
            vk_p2p_custom_keys_v1: JSON.stringify(customKeys),
            vk_p2p_settings_v1: JSON.stringify(makeBaseSettings()),
        },
    });

    await page.locator('#vk-p2p-key-btn').click();
    const styles = await page.locator('.vk-p2p-menu').evaluate(el => {
        const css = getComputedStyle(el);
        return {
            left: parseFloat(css.left),
            top: parseFloat(css.top),
            width: parseFloat(css.width),
            maxHeight: parseFloat(css.maxHeight),
            overflowY: css.overflowY,
        };
    });

    expect(styles.left).toBeGreaterThanOrEqual(0);
    expect(styles.top).toBeGreaterThanOrEqual(0);
    expect(styles.width).toBeLessThanOrEqual(390);
    expect(styles.maxHeight).toBeLessThanOrEqual(844);
    expect(['auto', 'scroll']).toContain(styles.overflowY);
});
