// Помощники для загрузки userscript в Playwright-контекст.
const fs = require('fs');
const os = require('os');
const path = require('path');

const USERSCRIPT_PATH = path.join(__dirname, '..', '..', 'extension', 'vkencrypt.template.js');

function loadUserscriptCode() {
    const raw = fs.readFileSync(USERSCRIPT_PATH, 'utf8');
    return raw.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');
}

const GM_STUBS = `
    (() => {
        const _store = new Map();
        window.GM_getValue = (k, d) => _store.has(k) ? _store.get(k) : d;
        window.GM_setValue = (k, v) => { _store.set(k, v); };
        window.GM_deleteValue = (k) => { _store.delete(k); };
        window.__gmStore = _store;
    })();
`;

// Синхронный setTimeout: скрипт планирует setTimeout(scan, 700) и
// setTimeout(() => input.focus(), 80). В Playwright MutationObserver-цикл
// в async-режиме иногда рвёт страницу; sync-режим стабилен и сканер
// срабатывает мгновенно.
const SYNC_STUB = `
    (() => {
        window.setTimeout = (cb) => { try { cb(); } catch (e) { console.error('st:', e); } return 0; };
        window.setInterval = () => 0;
    })();
`;

const MOCK_CSS = `
    .ConvoComposer__inputPanel { display:flex; gap:8px; padding:12px; align-items:center; }
    .ConvoComposer__button { width:32px; height:32px; }
    .ComposerInput__input { display:inline-block; min-width:200px; min-height:30px; border:1px solid #ccc; padding:8px; }
`;

const MOCK_BODY = `
    <div class="ConvoMessage__text">Привет от A</div>
    <div class="ConvoMessage__text">Как дела?</div>
    <div class="ConvoComposer__inputPanel">
        <div class="ConvoComposer__clip">
            <div class="DropdownReforged__trigger">
                <button class="ConvoComposer__button" aria-label="Загрузить файл">+</button>
            </div>
        </div>
        <div class="ComposerInput ConvoComposer__inputWrapper">
            <span contenteditable="true"
                  class="ComposerInput__input ConvoComposer__input"
                  role="textbox"
                  aria-multiline="true"
                  data-placeholder="Сообщение"></span>
        </div>
        <div class="DropdownReforged">
            <div class="DropdownReforged__trigger">
                <button class="ConvoComposer__button ConvoComposer__sendButton--mic"
                        aria-label="Отправить">
                    <i class="ConvoComposer__buttonIcon ConvoComposer__buttonIcon--submit">→</i>
                </button>
            </div>
        </div>
    </div>
`;

// Идемпотентно: открывает about:blank, добавляет мок-композер, ставит
// стабы GM_*, форсит sync setTimeout, инжектит userscript через
// page.evaluate (после полной загрузки страницы, когда document.body
// уже существует и MutationObserver привязывается корректно).
async function openMockChat(page) {
    await page.goto('about:blank');
    await page.evaluate(
        ({ body, css, gmStubs, syncStub, code }) => {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);

            document.body.innerHTML = body;

            // Стабы GM_*.
            (new Function(gmStubs))();

            // Sync setTimeout — иначе MutationObserver-цикл в async-режиме
            // иногда рвёт страницу, и тесты падают.
            (new Function(syncStub))();

            // Userscript.
            (new Function(code))();
        },
        {
            body: MOCK_BODY,
            css: MOCK_CSS,
            gmStubs: GM_STUBS,
            syncStub: SYNC_STUB,
            code: loadUserscriptCode(),
        }
    );
    await page.waitForSelector('#vk-p2p-enc-btn', { timeout: 5000 });
}

async function setupUserscript(page) {
    // Ничего не делаем — openMockChat уже всё настроил.
}

function makePlaintextHelper() {
    return {
        async setText(input, text) {
            await input.evaluate((el, t) => {
                el.focus();
                el.innerText = t;
                el.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: t,
                }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, text);
        },
        async getText(input) {
            return await input.evaluate(el => el.innerText.trim());
        },
    };
}

module.exports = {
    USERSCRIPT_PATH,
    loadUserscriptCode,
    GM_STUBS,
    openMockChat,
    setupUserscript,
    makePlaintextHelper,
};
