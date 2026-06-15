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

test('composer controls: вставляются на уровень inputPanel и перед dropdown отправки', async ({ page }) => {
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
            hasSendButton: !!el.querySelector?.('[aria-label*="Отправить"]'),
        }));
        return children;
    });

    const controlsIndex = order.findIndex(item => item.id === 'vk-p2p-enc-controls');
    const sendIndex = order.findIndex(item => item.hasSendButton);
    expect(controlsIndex).toBeGreaterThanOrEqual(0);
    expect(sendIndex).toBeGreaterThan(controlsIndex);
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
