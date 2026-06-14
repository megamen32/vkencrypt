// ==UserScript==
// @name         VK P2P AES-GCM (Key Input)
// @namespace    local
// @version      3.4
// @description  P2P шифрование + ввод ключа прямо в интерфейсе (без сохранения)
// @author       VKEncrypt
// @match        https://vk.com/*
// @match        https://m.vk.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js
// @downloadURL  https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // ⚠️  ВНИМАНИЕ: ЭТО ДЕМО-КЛЮЧИ. ИХ ВИДИТ ЛЮБОЙ, КТО ЧИТАЛ README.
    // ⚠️  ПЕРЕД СЕРЬЁЗНЫМ ИСПОЛЬЗОВАНИЕМ ОБЯЗАТЕЛЬНО ЗАМЕНИ:
    // ⚠️    1) сгенерируй новые:  cd bot && python3 gen_key.py
    // ⚠️    2) впиши их в bot/.env как PRE_SHARED_KEY_K1..K4
    // ⚠️    3) пересобери userscript: cd extension && ./build.sh
    // ⚠️    4) переустанови userscript в Tampermonkey (Replace)
    // ⚠️  Либо используй 🔑 → ⚡ сгенерировать новый ключ (P2P, без правки файлов).
    // ============================================================
    const STATIC_KEYS = {
        "k1": "739d0532b4c9d21868c95928132c9d2864c28ab4446efa66ebb38ac3a1d26758",
        "k2": "1579579225afbbd602ca0cbcd3507debd5efe0469b0b6ea5b2faaf9415da443c",
        "k3": "42a2f05bacefb47b48c109ae68c752bbd1c2f77cbaae4eed6aac1daeab0bbd32",
        "k4": "8f5cc901e7658fd6b1e66dfef11534a5497a30948434e6295202457cafaca0af",
    };

    // === ⚡ Временный ключ (только в памяти!) ===
    let TEMP_KEY = null; // Исчезнет при перезагрузке страницы

    const DEFAULT_KEY_SLOT = "k1";
    let currentKeySlot = DEFAULT_KEY_SLOT;

    const PREFIX = "ENC[";
    const SUFFIX = "]";
    const IV_LEN = 12;
    const TAG_LEN = 16;

    // --- Утилиты ---
    function hexToBytes(hex) {
        if (hex.length % 2 !== 0) throw new Error("Invalid hex");
        const arr = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            arr[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return arr;
    }

    function getAllKeys() {
        // Объединяем статические + временный ключ
        const all = { ...STATIC_KEYS };
        if (TEMP_KEY) all["@temp"] = TEMP_KEY;
        return all;
    }

    // --- Криптография ---
    async function decryptAESGCM(b64Payload, keyHex) {
        const bin = atob(b64Payload);
        const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);

        if (data.length < IV_LEN + TAG_LEN) throw new Error("Data too short");

        const iv = data.slice(0, IV_LEN);
        const ciphertextWithTag = data.slice(IV_LEN);

        const key = await crypto.subtle.importKey(
            "raw", hexToBytes(keyHex), { name: "AES-GCM" }, false, ["decrypt"]
        );

        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv, tagLength: 128 }, key, ciphertextWithTag
        );

        return new TextDecoder().decode(decrypted);
    }

    async function encryptAESGCM(plainText, keyHex) {
        const key = await crypto.subtle.importKey(
            "raw", hexToBytes(keyHex), { name: "AES-GCM" }, false, ["encrypt"]
        );

        const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
        const encoder = new TextEncoder();
        const data = encoder.encode(plainText);

        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, tagLength: 128 }, key, data
        );

        const encryptedArr = new Uint8Array(encrypted);
        const payload = new Uint8Array(iv.length + encryptedArr.length);
        payload.set(iv);
        payload.set(encryptedArr, iv.length);

        let binary = '';
        for (let i = 0; i < payload.length; i++) {
            binary += String.fromCharCode(payload[i]);
        }
        return btoa(binary);
    }

    // --- UI: Переключатель [шифр]/[текст] ---
    function createToggleInterface(originalEnc, decryptedText, parentEl) {
        parentEl.innerHTML = '';

        const textSpan = document.createElement('span');
        textSpan.className = 'vk-dec-content';
        textSpan.textContent = decryptedText;
        textSpan.style.fontWeight = 'normal';

        const toggleLink = document.createElement('a');
        toggleLink.href = "#";
        toggleLink.className = 'vk-dec-toggle';
        toggleLink.textContent = '[шифр]';
        toggleLink.title = 'Показать зашифрованный оригинал';
        toggleLink.style.cssText = `
            display:inline-block; margin-left:8px; font-size:11px;
            text-decoration:underline; cursor:pointer; opacity:0.6;
            user-select:none; color:inherit;
        `;

        toggleLink.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (toggleLink.textContent === '[шифр]') {
                textSpan.textContent = originalEnc;
                textSpan.style.fontFamily = 'monospace';
                toggleLink.textContent = '[текст]';
            } else {
                textSpan.textContent = decryptedText;
                textSpan.style.fontFamily = '';
                toggleLink.textContent = '[шифр]';
            }
        };

        parentEl.appendChild(textSpan);
        parentEl.appendChild(document.createTextNode(' '));
        parentEl.appendChild(toggleLink);
        parentEl.dataset.vkdecDone = 'true';
    }

    // --- Обработка входящих ---
    async function processIncomingMessage(msgEl) {
        if (msgEl.dataset.vkdecDone) return;

        const text = msgEl.textContent?.trim() || "";
        if (!text.startsWith(PREFIX) || !text.endsWith(SUFFIX)) return;

        const inner = text.slice(PREFIX.length, -SUFFIX.length);
        const colon = inner.indexOf(':');
        if (colon === -1) return;

        const keyId = inner.slice(0, colon);
        const payload = inner.slice(colon + 1);
        const keys = getAllKeys();
        const keyHex = keys[keyId];

        if (!keyHex) {
            console.warn(`🔑 Ключ "${keyId}" не найден`);
            return;
        }

        try {
            const decrypted = await decryptAESGCM(payload, keyHex);
            createToggleInterface(text, decrypted, msgEl);
        } catch (err) {
            console.error('❌ Ошибка расшифровки:', err.message);
            msgEl.textContent = `[❌ ${err.message}]`;
            msgEl.dataset.vkdecDone = 'true';
        }
    }

    // --- UI: Ввод временного ключа ---
    function showTempKeyInput() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed; top:0; left:0; width:100%; height:100%;
            background:rgba(0,0,0,0.7); z-index:99999;
            display:flex; align-items:center; justify-content:center;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background:#fff; color:#000; padding:20px; border-radius:12px;
            max-width:90vw; width:400px; box-shadow:0 4px 20px rgba(0,0,0,0.3);
        `;

        modal.innerHTML = `
            <h3 style="margin:0 0 16px;font-size:16px">🔑 Временный ключ</h3>
            <p style="margin:0 0 12px;font-size:13px;opacity:0.8">
                Ключ хранится только в памяти и исчезнет при обновлении страницы.
            </p>
            <input type="text" id="vk-temp-key-input" placeholder="64 hex-символа (256 бит)"
                style="width:100%;padding:10px;font-family:monospace;font-size:13px;margin-bottom:12px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box">
            <div style="display:flex;gap:8px;justify-content:flex-end">
                <button id="vk-temp-key-cancel" style="padding:8px 16px;border:none;background:#f0f0f0;border-radius:6px;cursor:pointer">Отмена</button>
                <button id="vk-temp-key-save" style="padding:8px 16px;border:none;background:#0077FF;color:#fff;border-radius:6px;cursor:pointer">Применить</button>
            </div>
            <p id="vk-temp-key-error" style="color:#c00;font-size:12px;margin:8px 0 0;display:none"></p>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const input = document.getElementById('vk-temp-key-input');
        const error = document.getElementById('vk-temp-key-error');

        setTimeout(() => input.focus(), 100);

        overlay.onclick = (e) => {
            if (e.target === overlay) hideModal();
        };

        document.getElementById('vk-temp-key-cancel').onclick = hideModal;

        document.getElementById('vk-temp-key-save').onclick = () => {
            const val = input.value.trim().toLowerCase();

            if (!/^[0-9a-f]{64}$/.test(val)) {
                error.textContent = 'Ключ должен быть ровно 64 hex-символа';
                error.style.display = 'block';
                return;
            }

            TEMP_KEY = val;
            currentKeySlot = "@temp";

            hideModal();
            scan();

            showToast('✅ Временный ключ применён');
        };

        input.onkeypress = (e) => {
            if (e.key === 'Enter') document.getElementById('vk-temp-key-save').click();
        };

        function hideModal() {
            overlay.remove();
        }

        const style = document.createElement('style');
        style.textContent = `@keyframes fadeout { to { opacity:0; transform:translate(-50%, 10px); } }`;
        document.head.appendChild(style);
    }

    // --- Генерация нового временного ключа ---
    async function generateTempKey() {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const keyHex = Array.from(bytes)
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('');

        TEMP_KEY = keyHex;
        currentKeySlot = '@temp';
        updateEncryptButtonsTitle();
        scan();

        try {
            await navigator.clipboard.writeText(keyHex);
            showToast('✅ Новый ключ создан и скопирован');
        } catch (err) {
            console.warn('Не удалось скопировать ключ:', err.message);
            showGeneratedKeyModal(keyHex);
        }
    }

    function showToast(text) {
        const toast = document.createElement('div');
        toast.textContent = text;
        toast.style.cssText = `
            position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
            background:#2d3b45; color:#fff; padding:10px 16px; border-radius:8px;
            font-size:13px; z-index:100000; animation:fadeout 2s forwards;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    function showGeneratedKeyModal(keyHex) {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed; top:0; left:0; width:100%; height:100%;
            background:rgba(0,0,0,0.7); z-index:99999;
            display:flex; align-items:center; justify-content:center;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background:#fff; color:#000; padding:20px; border-radius:12px;
            max-width:90vw; width:460px; box-shadow:0 4px 20px rgba(0,0,0,0.3);
        `;

        modal.innerHTML = `
            <h3 style="margin:0 0 16px;font-size:16px">🔑 Новый временный ключ</h3>
            <p style="margin:0 0 12px;font-size:13px;opacity:0.8">
                Ключ создан и применён. Скопируйте его вручную и передайте собеседнику.
            </p>
            <textarea readonly id="vk-generated-key-output"
                style="width:100%;height:84px;padding:10px;font-family:monospace;font-size:13px;margin-bottom:12px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;resize:none">${keyHex}</textarea>
            <div style="display:flex;gap:8px;justify-content:flex-end">
                <button id="vk-generated-key-copy" style="padding:8px 16px;border:none;background:#0077FF;color:#fff;border-radius:6px;cursor:pointer">Скопировать</button>
                <button id="vk-generated-key-close" style="padding:8px 16px;border:none;background:#f0f0f0;border-radius:6px;cursor:pointer">Закрыть</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const output = document.getElementById('vk-generated-key-output');
        output.focus();
        output.select();

        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };

        document.getElementById('vk-generated-key-close').onclick = () => overlay.remove();
        document.getElementById('vk-generated-key-copy').onclick = async () => {
            try {
                await navigator.clipboard.writeText(keyHex);
                overlay.remove();
                showToast('✅ Ключ скопирован');
            } catch (err) {
                output.focus();
                output.select();
            }
        };
    }

    // --- UI: Выбор ключа рядом с кнопкой шифрования ---
    function showKeyMenu(anchorBtn) {
        const old = document.getElementById('vk-p2p-key-menu');
        if (old) old.remove();

        const menu = document.createElement('div');
        menu.id = 'vk-p2p-key-menu';
        menu.style.cssText = `
            position:fixed;
            z-index:100000;
            background:#fff;
            color:#000;
            border:1px solid rgba(0,0,0,0.15);
            border-radius:10px;
            box-shadow:0 8px 24px rgba(0,0,0,0.22);
            padding:6px;
            min-width:150px;
            font-size:13px;
        `;

        const rect = anchorBtn.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.top - 8}px`;
        menu.style.transform = 'translateY(-100%)';

        const keys = getAllKeys();

        Object.keys(keys).forEach(slotId => {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = slotId === '@temp'
                ? `${slotId} временный`
                : slotId;

            item.style.cssText = `
                display:block;
                width:100%;
                text-align:left;
                padding:8px 10px;
                border:none;
                background:${slotId === currentKeySlot ? '#e8f1ff' : 'transparent'};
                color:inherit;
                border-radius:7px;
                cursor:pointer;
                font:inherit;
            `;

            item.onclick = () => {
                currentKeySlot = slotId;
                menu.remove();
                updateEncryptButtonsTitle();
            };

            menu.appendChild(item);
        });

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '+ временный ключ';
        addBtn.style.cssText = `
            display:block;
            width:100%;
            text-align:left;
            padding:8px 10px;
            border:none;
            background:transparent;
            color:#0077ff;
            border-radius:7px;
            cursor:pointer;
            font:inherit;
            border-top:1px solid #eee;
            margin-top:4px;
        `;

        addBtn.onclick = () => {
            menu.remove();
            showTempKeyInput();
        };

        menu.appendChild(addBtn);

        const generateBtn = document.createElement('button');
        generateBtn.type = 'button';
        generateBtn.textContent = '⚡ сгенерировать новый ключ';
        generateBtn.style.cssText = `
            display:block;
            width:100%;
            text-align:left;
            padding:8px 10px;
            border:none;
            background:transparent;
            color:#0077ff;
            border-radius:7px;
            cursor:pointer;
            font:inherit;
        `;

        generateBtn.onclick = () => {
            menu.remove();
            generateTempKey();
        };

        menu.appendChild(generateBtn);

        if (TEMP_KEY) {
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.textContent = 'удалить временный ключ';
            clearBtn.style.cssText = `
                display:block;
                width:100%;
                text-align:left;
                padding:8px 10px;
                border:none;
                background:transparent;
                color:#c00;
                border-radius:7px;
                cursor:pointer;
                font:inherit;
            `;

            clearBtn.onclick = () => {
                TEMP_KEY = null;
                if (currentKeySlot === '@temp') currentKeySlot = DEFAULT_KEY_SLOT;
                menu.remove();
                updateEncryptButtonsTitle();
                scan();
            };

            menu.appendChild(clearBtn);
        }

        document.body.appendChild(menu);

        setTimeout(() => {
            document.addEventListener('click', closeMenuOnce, { once: true });
        }, 0);

        function closeMenuOnce(e) {
            if (!menu.contains(e.target) && e.target !== anchorBtn) {
                menu.remove();
            }
        }
    }

    function updateEncryptButtonsTitle() {
        const encBtn = document.getElementById('vk-p2p-enc-btn');
        const keyBtn = document.getElementById('vk-p2p-key-btn');

        if (encBtn) {
            encBtn.title = `Зашифровать отправленное сообщение (ключ: ${currentKeySlot})`;
        }

        if (keyBtn) {
            keyBtn.title = `Сменить ключ. Сейчас: ${currentKeySlot}`;
            keyBtn.textContent = currentKeySlot === '@temp' ? '⚡' : '🔑';
        }
    }

    function addKeySelector() {
        const old = document.getElementById('vk-p2p-key-select');
        if (old) old.remove();
    }

    // --- UI: Кнопка шифрования + кнопка смены ключа ---
    function addEncryptButton() {
        if (document.getElementById('vk-p2p-enc-btn')) return;

        const inputSelectors = [
            '.ComposerInput__input.ConvoComposer__input',
            '.im-editable',
            '[contenteditable="true"]'
        ];

        const inputEl = inputSelectors.map(s => document.querySelector(s)).find(el => el);
        if (!inputEl) return;

        const panel = inputEl.closest('.ConvoComposer__inputPanel, .im-compose');
        if (!panel) return;

        const wrapper = document.createElement('span');
        wrapper.id = 'vk-p2p-enc-controls';
        wrapper.style.cssText = `
            display:inline-flex;
            align-items:center;
            gap:2px;
            margin-right:4px;
        `;

        const btn = document.createElement('button');
        btn.id = 'vk-p2p-enc-btn';
        btn.innerHTML = '🔒';
        btn.title = `Зашифровать отправленное сообщение (ключ: ${currentKeySlot})`;
        btn.type = 'button';
        btn.style.cssText = `
            background:transparent; border:none; cursor:pointer; padding:8px 4px 8px 8px;
            font-size:18px; opacity:0.55; transition:opacity 0.2s;
            color:inherit;
        `;

        const keyBtn = document.createElement('button');
        keyBtn.id = 'vk-p2p-key-btn';
        keyBtn.textContent = currentKeySlot === '@temp' ? '⚡' : '🔑';
        keyBtn.title = `Сменить ключ. Сейчас: ${currentKeySlot}`;
        keyBtn.type = 'button';
        keyBtn.style.cssText = `
            background:transparent; border:none; cursor:pointer; padding:8px 8px 8px 2px;
            font-size:15px; opacity:0.55; transition:opacity 0.2s;
            color:inherit;
        `;

        [btn, keyBtn].forEach(b => {
            b.onmouseenter = () => b.style.opacity = '1';
            b.onmouseleave = () => b.style.opacity = '0.55';
        });

        keyBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showKeyMenu(keyBtn);
        };

        btn.onclick = async () => {
            const plainText = inputEl.innerText.trim();
            if (!plainText) return;

            const keys = getAllKeys();
            const keyHex = keys[currentKeySlot];

            if (!keyHex) {
                alert(`Ключ "${currentKeySlot}" не найден`);
                return;
            }

            btn.disabled = true;
            btn.style.opacity = '0.3';
            btn.textContent = '⏳';

            try {
                const b64 = await encryptAESGCM(plainText, keyHex);
                const encryptedMsg = `${PREFIX}${currentKeySlot}:${b64}${SUFFIX}`;

                inputEl.innerText = encryptedMsg;
                inputEl.focus();

                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(inputEl);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);

                inputEl.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: encryptedMsg
                }));
            } catch (err) {
                console.error('❌ Ошибка шифрования:', err);
                alert('Не удалось зашифровать: ' + err.message);
            } finally {
                btn.disabled = false;
                btn.style.opacity = '0.55';
                btn.textContent = '🔒';
                updateEncryptButtonsTitle();
            }
        };

        wrapper.appendChild(btn);
        wrapper.appendChild(keyBtn);

        const sendBtn = panel.querySelector('.ConvoComposer__button:last-child, [aria-label*="Отправить"]');

        if (sendBtn?.parentNode) {
            sendBtn.parentNode.insertBefore(wrapper, sendBtn);
        } else {
            panel.appendChild(wrapper);
        }

        updateEncryptButtonsTitle();
    }

    // --- Главный цикл ---
    function scan() {
        document.querySelectorAll('.ConvoMessage__text, .MessageText, .im_msg_text, .im-message--text')
            .forEach(el => processIncomingMessage(el));
        addKeySelector();
        addEncryptButton();
    }

    console.log('🔐 VK P2P Encrypt v3.3 loaded');
    console.log('📦 Статические ключи:', Object.keys(STATIC_KEYS).join(', '));
    console.log('⚡ Временный ключ:', TEMP_KEY ? '✅' : '❌');

    setTimeout(scan, 1000);
    const obs = new MutationObserver(scan);
    obs.observe(document.body, { childList: true, subtree: true });

})();
