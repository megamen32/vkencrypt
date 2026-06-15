// ==UserScript==
// @name         VK P2P AES-GCM
// @namespace    local
// @version      5.0
// @description  P2P шифрование VK: seed-фраза, сохранение ключей, пользовательские ключи, автошифрование, emoji-шифротекст
// @author       VKEncrypt
// @match        https://vk.com/*
// @match        https://m.vk.com/*
// @match        https://vk.ru/*
// @match        https://m.vk.ru/*
// @match        https://web.vk.me/*
// @match        https://m.web.vk.me/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js
// @downloadURL  https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // VK P2P AES-GCM v5.0
    //
    // Что умеет:
    // - НЕ показывает модалку сразу после установки.
    // - Пока ключей нет, кнопки возле поля ввода открывают настройку.
    // - В seed-модалках есть "глаз" для просмотра вводимой фразы.
    // - Из seed-фразы детерминированно генерирует k1..k4.
    // - Сохраняет НЕ seed-фразу, а только производные ключи.
    // - Поддерживает пользовательские ключи 64 hex.
    // - Поддерживает временный ключ только в памяти.
    // - Умеет автошифровать при клике отправки и при Enter.
    // - Shift+Enter оставляет как перенос строки.
    // - При включённом автошифровании ручной замок скрывается.
    // - Опционально кодирует payload в emoji-алфавит.
    // ============================================================

    const APP_NAME = 'VK P2P AES-GCM';
    const APP_VERSION = '5.0';

    const FORMAT_START = '𓁗';
    const FORMAT_MID = 'Ⰴ';
    const FORMAT_PAYLOAD = 'Ⱑ';
    const CODEC_MARKERS = {
        base64: '𐌁',
        emoji: '𐌄',
        cyrillic: '𐌓'
    };

    const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    // 64 emoji для замены Base64-символов.
    // Важно: режим emoji опциональный, Base64 надёжнее для копирования/пересылки.
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
        'ш','щ','ъ','ы','ь','э','ю','я'
    ];

    const CIPHER_CODECS = {
        base64: { shortCode: CODEC_MARKERS.base64, label: 'Base64' },
        emoji: { shortCode: CODEC_MARKERS.emoji, label: 'Emoji' },
        cyrillic: { shortCode: CODEC_MARKERS.cyrillic, label: 'Русский алфавит' }
    };

    const IV_LEN = 12;
    const TAG_LEN = 16;

    const DEFAULT_KEY_SLOT = 'k1';

    const STORAGE_KEYS = {
        DERIVED_KEYS: 'vk_p2p_derived_keys_v1',
        CUSTOM_KEYS: 'vk_p2p_custom_keys_v1',
        SETTINGS: 'vk_p2p_settings_v1'
    };

    const KDF_SALT = 'vk-p2p-aes-gcm-v1';
    const KDF_ITERATIONS = 250000;

    let DERIVED_KEYS = null;
    let CUSTOM_KEYS = {};
    let TEMP_KEY = null;

    let currentKeySlot = DEFAULT_KEY_SLOT;

    let settings = {
        autoEncrypt: false,
        saveDerivedKeys: true,
        autoDecrypt: true,
        cipherCodec: 'emoji'
    };

    let isAutoSending = false;
    let lastEncryptedAt = 0;
    let scanTimer = null;

    // ============================================================
    // Storage
    // ============================================================

    function safeJsonParse(value, fallback) {
        try {
            if (!value) return fallback;
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }

    function gmGetJson(key, fallback) {
        return safeJsonParse(GM_getValue(key, null), fallback);
    }

    function gmSetJson(key, value) {
        GM_setValue(key, JSON.stringify(value));
    }

    function loadSettings() {
        const saved = gmGetJson(STORAGE_KEYS.SETTINGS, null);
        if (saved && typeof saved === 'object') {
            const normalized = { ...saved };

            if (typeof normalized.autoDecrypt !== 'boolean' && typeof normalized.decryptIncoming === 'boolean') {
                normalized.autoDecrypt = normalized.decryptIncoming;
            }

            if (!Object.prototype.hasOwnProperty.call(normalized, 'cipherCodec')) {
                normalized.cipherCodec = normalized.emojiCipher ? 'emoji' : 'base64';
            }

            settings = {
                ...settings,
                ...normalized
            };
        }
    }

    function saveSettings() {
        gmSetJson(STORAGE_KEYS.SETTINGS, {
            ...settings,
            decryptIncoming: settings.autoDecrypt,
            emojiCipher: settings.cipherCodec === 'emoji'
        });
    }

    function isValidKeyHex(hex) {
        return typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex);
    }

    function areValidDerivedKeys(keys) {
        return Boolean(
            keys &&
            isValidKeyHex(keys.k1) &&
            isValidKeyHex(keys.k2) &&
            isValidKeyHex(keys.k3) &&
            isValidKeyHex(keys.k4)
        );
    }

    function normalizeKeyObject(obj) {
        const out = {};
        for (const [k, v] of Object.entries(obj || {})) {
            if (isValidKeyHex(v)) out[k] = String(v).toLowerCase();
        }
        return out;
    }

    function normalizeCustomKeyEntry(raw) {
        if (!raw) return null;

        if (typeof raw === 'string') {
            if (!isValidKeyHex(raw)) return null;
            return { key: raw.toLowerCase(), label: '' };
        }

        if (typeof raw === 'object') {
            if (!isValidKeyHex(raw.key)) return null;
            const label = typeof raw.label === 'string'
                ? raw.label.trim().slice(0, 64)
                : '';
            return { key: String(raw.key).toLowerCase(), label };
        }

        return null;
    }

    function loadDerivedKeys() {
        const saved = gmGetJson(STORAGE_KEYS.DERIVED_KEYS, null);
        if (areValidDerivedKeys(saved)) return normalizeKeyObject(saved);
        return null;
    }

    function saveDerivedKeys(keys) {
        if (!areValidDerivedKeys(keys)) return;
        gmSetJson(STORAGE_KEYS.DERIVED_KEYS, normalizeKeyObject(keys));
    }

    function clearDerivedKeys() {
        GM_deleteValue(STORAGE_KEYS.DERIVED_KEYS);
        DERIVED_KEYS = null;
    }

    function loadCustomKeys() {
        const saved = gmGetJson(STORAGE_KEYS.CUSTOM_KEYS, {});
        const out = {};
        for (const [slot, raw] of Object.entries(saved || {})) {
            const normalized = normalizeCustomKeyEntry(raw);
            if (normalized) out[slot] = normalized;
        }
        CUSTOM_KEYS = out;
    }

    function saveCustomKeys() {
        gmSetJson(STORAGE_KEYS.CUSTOM_KEYS, CUSTOM_KEYS);
    }

    function resetAllKeys() {
        clearDerivedKeys();
        GM_deleteValue(STORAGE_KEYS.CUSTOM_KEYS);
        CUSTOM_KEYS = {};
        TEMP_KEY = null;
        currentKeySlot = DEFAULT_KEY_SLOT;
        updateEncryptButtonsTitle();
        showSeedSetupModal();
    }

    // ============================================================
    // Crypto helpers
    // ============================================================

    function hexToBytes(hex) {
        if (!isValidKeyHex(hex)) throw new Error('Invalid key hex');
        const arr = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            arr[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return arr;
    }

    function bytesToHex(bytes) {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;

        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }

        return btoa(binary);
    }

    function base64ToBytes(b64) {
        const bin = atob(b64);
        const data = new Uint8Array(bin.length);

        for (let i = 0; i < bin.length; i++) {
            data[i] = bin.charCodeAt(i);
        }

        return data;
    }

    function encodeBase64ToAlphabet(b64, alphabet, padChar = '=') {
        let out = '';

        for (const ch of b64) {
            if (ch === '=') {
                continue;
            }

            const idx = BASE64_ALPHABET.indexOf(ch);
            if (idx === -1) throw new Error('Invalid base64 char: ' + ch);
            out += alphabet[idx];
        }

        return out;
    }

    function decodeAlphabetToBase64(payload, alphabet, padChar = '=') {
        let out = '';

        for (const symbol of Array.from(payload)) {
            if (symbol === padChar) {
                out += '=';
                continue;
            }

            const idx = alphabet.indexOf(symbol);
            if (idx === -1) throw new Error('Invalid cipher symbol: ' + symbol);
            out += BASE64_ALPHABET[idx];
        }

        return out + '='.repeat((4 - (out.length % 4)) % 4);
    }

    function encodeBase64ToEmoji(b64) {
        return encodeBase64ToAlphabet(b64, EMOJI_ALPHABET, EMOJI_PAD);
    }

    function decodeEmojiToBase64(payload) {
        return decodeAlphabetToBase64(payload, EMOJI_ALPHABET, EMOJI_PAD);
    }

    function encodeBase64ToCyrillic(b64) {
        return encodeBase64ToAlphabet(b64, CYRILLIC_ALPHABET);
    }

    function decodeCyrillicToBase64(payload) {
        return decodeAlphabetToBase64(payload, CYRILLIC_ALPHABET);
    }

    function getCipherCodecConfig(codecId) {
        return CIPHER_CODECS[codecId] || CIPHER_CODECS.emoji;
    }

    function normalizeCodecId(codecId) {
        return Object.prototype.hasOwnProperty.call(CIPHER_CODECS, codecId) ? codecId : 'emoji';
    }

    function encodePayloadForCodec(b64, codecId) {
        switch (normalizeCodecId(codecId)) {
            case 'base64':
                return b64.replace(/=+$/u, '');
            case 'cyrillic':
                return encodeBase64ToCyrillic(b64);
            case 'emoji':
            default:
                return encodeBase64ToEmoji(b64);
        }
    }

    function decodePayloadForCodec(payload, codecId) {
        switch (normalizeCodecId(codecId)) {
            case 'base64':
                return payload + '='.repeat((4 - (payload.length % 4)) % 4);
            case 'cyrillic':
                return decodeCyrillicToBase64(payload);
            case 'emoji':
            default:
                return decodeEmojiToBase64(payload);
        }
    }

    function isValidBase64Payload(payload) {
        return typeof payload === 'string'
            && payload.length >= 4
            && payload.length % 4 === 0
            && /^[A-Za-z0-9+/]+={0,2}$/.test(payload);
    }

    function isPlausibleEncodedPayload(payload, codecId) {
        if (typeof payload !== 'string' || !payload) return false;

        try {
            const b64 = decodePayloadForCodec(payload, codecId);
            return isValidBase64Payload(b64);
        } catch {
            return false;
        }
    }

    function toCompactKeyId(slotId) {
        const match = /^k([1-4])$/.exec(slotId);
        return match ? match[1] : slotId;
    }

    function fromCompactKeyId(compactId) {
        return /^[1-4]$/.test(compactId) ? `k${compactId}` : compactId;
    }

    function formatEncryptedMessage(slotId, payload, codecId) {
        const codec = getCipherCodecConfig(codecId);
        return `${FORMAT_START}${toCompactKeyId(slotId)}${FORMAT_MID}${codec.shortCode}${FORMAT_PAYLOAD}${payload}`;
    }

    function parseEncryptedMessage(text) {
        const trimmed = (text || '').trim();
        const compactMatch = new RegExp(`^${FORMAT_START}(.+?)${FORMAT_MID}([${CODEC_MARKERS.base64}${CODEC_MARKERS.emoji}${CODEC_MARKERS.cyrillic}])${FORMAT_PAYLOAD}(.+)$`, 'su').exec(trimmed);
        if (!compactMatch) return null;

        const parsed = {
            originalText: trimmed,
            keyId: fromCompactKeyId(compactMatch[1]),
            codecId: compactMatch[2] === CODEC_MARKERS.emoji
                ? 'emoji'
                : compactMatch[2] === CODEC_MARKERS.cyrillic
                    ? 'cyrillic'
                    : 'base64',
            encodedPayload: compactMatch[3]
        };

        return isPlausibleEncodedPayload(parsed.encodedPayload, parsed.codecId)
            ? parsed
            : null;
    }

    async function deriveKeyMaterialFromSeed(seedText) {
        const encoder = new TextEncoder();

        const baseKey = await crypto.subtle.importKey(
            'raw',
            encoder.encode(seedText),
            'PBKDF2',
            false,
            ['deriveBits']
        );

        const bits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: encoder.encode(KDF_SALT),
                iterations: KDF_ITERATIONS,
                hash: 'SHA-256'
            },
            baseKey,
            1024
        );

        const bytes = new Uint8Array(bits);

        return {
            k1: bytesToHex(bytes.slice(0, 32)),
            k2: bytesToHex(bytes.slice(32, 64)),
            k3: bytesToHex(bytes.slice(64, 96)),
            k4: bytesToHex(bytes.slice(96, 128))
        };
    }

    async function deriveKeyFromName(name) {
        if (!name || !name.trim()) {
            throw new Error('Пустое слово');
        }
        const hash = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(name.trim())
        );
        return bytesToHex(new Uint8Array(hash));
    }

    async function encryptAESGCM(plainText, keyHex) {
        const key = await crypto.subtle.importKey(
            'raw',
            hexToBytes(keyHex),
            { name: 'AES-GCM' },
            false,
            ['encrypt']
        );

        const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
        const data = new TextEncoder().encode(plainText);

        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            key,
            data
        );

        const encryptedArr = new Uint8Array(encrypted);
        const payload = new Uint8Array(iv.length + encryptedArr.length);

        payload.set(iv);
        payload.set(encryptedArr, iv.length);

        return bytesToBase64(payload);
    }

    async function decryptAESGCM(b64Payload, keyHex) {
        const data = base64ToBytes(b64Payload);

        if (data.length < IV_LEN + TAG_LEN) {
            throw new Error('Data too short');
        }

        const iv = data.slice(0, IV_LEN);
        const ciphertextWithTag = data.slice(IV_LEN);

        const key = await crypto.subtle.importKey(
            'raw',
            hexToBytes(keyHex),
            { name: 'AES-GCM' },
            false,
            ['decrypt']
        );

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            key,
            ciphertextWithTag
        );

        return new TextDecoder().decode(decrypted);
    }

    function getAllKeys() {
        const all = {};

        if (DERIVED_KEYS) Object.assign(all, DERIVED_KEYS);
        if (CUSTOM_KEYS) {
            for (const [slot, info] of Object.entries(CUSTOM_KEYS)) {
                if (info && typeof info === 'object' && info.key) {
                    all[slot] = info.key;
                } else if (typeof info === 'string') {
                    all[slot] = info;
                }
            }
        }
        if (TEMP_KEY) all['@temp'] = TEMP_KEY;

        return all;
    }

    function getCustomKeyLabel(slot) {
        const info = CUSTOM_KEYS[slot];
        if (!info || typeof info !== 'object') return '';
        return info.label || '';
    }

    function getCurrentKeyHex() {
        return getAllKeys()[currentKeySlot] || null;
    }

    function hasAnyKeys() {
        return Boolean(DERIVED_KEYS || Object.keys(CUSTOM_KEYS).length || TEMP_KEY);
    }

    // ============================================================
    // Styles
    // ============================================================

    function injectStyles() {
        if (document.getElementById('vk-p2p-styles')) return;

        const style = document.createElement('style');
        style.id = 'vk-p2p-styles';
        style.textContent = `
            @keyframes vkP2PFadeIn {
                from { opacity: 0; transform: translateY(8px) scale(0.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }

            @keyframes vkP2PToastOut {
                0% { opacity: 1; transform: translate(-50%, 0); }
                75% { opacity: 1; transform: translate(-50%, 0); }
                100% { opacity: 0; transform: translate(-50%, 12px); }
            }

            .vk-p2p-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.62);
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 16px;
                box-sizing: border-box;
                backdrop-filter: blur(4px);
            }

            .vk-p2p-modal {
                width: min(480px, 100%);
                max-height: calc(100vh - 32px);
                overflow-y: auto;
                background: #ffffff;
                color: #111827;
                border-radius: 18px;
                box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
                padding: 20px;
                box-sizing: border-box;
                animation: vkP2PFadeIn 0.18s ease-out;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            }

            .vk-p2p-modal h3 {
                margin: 0 0 8px;
                font-size: 18px;
                line-height: 1.25;
                font-weight: 700;
            }

            .vk-p2p-modal p {
                margin: 0 0 12px;
                font-size: 13px;
                line-height: 1.45;
                color: #4b5563;
            }

            .vk-p2p-row {
                display: flex;
                gap: 8px;
                align-items: center;
            }

            .vk-p2p-input,
            .vk-p2p-select,
            .vk-p2p-textarea {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid #d1d5db;
                background: #fff;
                color: #111827;
                border-radius: 10px;
                padding: 11px 12px;
                font-size: 14px;
                outline: none;
                transition: border-color 0.15s, box-shadow 0.15s;
            }

            .vk-p2p-input:focus,
            .vk-p2p-select:focus,
            .vk-p2p-textarea:focus {
                border-color: #2688eb;
                box-shadow: 0 0 0 3px rgba(38, 136, 235, 0.15);
            }

            .vk-p2p-textarea {
                min-height: 84px;
                resize: vertical;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            }

            .vk-p2p-check {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                font-size: 13px;
                line-height: 1.35;
                color: #374151;
                margin: 8px 0 12px;
                user-select: none;
            }

            .vk-p2p-check input {
                margin-top: 2px;
            }

            .vk-p2p-actions {
                display: flex;
                justify-content: flex-end;
                gap: 8px;
                margin-top: 14px;
                flex-wrap: wrap;
            }

            .vk-p2p-btn {
                border: none;
                border-radius: 10px;
                padding: 9px 13px;
                font-size: 13px;
                cursor: pointer;
                transition: transform 0.08s, opacity 0.15s, background 0.15s;
                white-space: nowrap;
            }

            .vk-p2p-btn:active {
                transform: translateY(1px);
            }

            .vk-p2p-btn:disabled {
                opacity: 0.55;
                cursor: default;
            }

            .vk-p2p-btn-primary {
                background: #2688eb;
                color: #fff;
            }

            .vk-p2p-btn-secondary {
                background: #f3f4f6;
                color: #111827;
            }

            .vk-p2p-btn-danger {
                background: #fee2e2;
                color: #991b1b;
            }

            .vk-p2p-eye-btn {
                min-width: 44px;
                padding-left: 10px;
                padding-right: 10px;
            }

            .vk-p2p-error {
                display: none;
                color: #b91c1c !important;
                font-size: 12px !important;
                margin-top: 8px !important;
            }

            .vk-p2p-note {
                border-radius: 12px;
                padding: 10px 12px;
                background: #f3f7ff;
                color: #31527a !important;
                font-size: 12px !important;
            }

            .vk-p2p-controls {
                display: inline-flex;
                align-items: center;
                gap: 2px;
                margin-right: 4px;
                vertical-align: middle;
            }

            .vk-p2p-icon-btn {
                background: transparent;
                border: none;
                cursor: pointer;
                color: inherit;
                opacity: 0.58;
                padding: 7px 5px;
                border-radius: 8px;
                line-height: 1;
                transition: opacity 0.15s, background 0.15s;
            }

            .vk-p2p-icon-btn:hover {
                opacity: 1;
                background: rgba(127, 127, 127, 0.10);
            }

            .vk-p2p-icon-btn-main {
                font-size: 18px;
            }

            .vk-p2p-icon-btn-small {
                font-size: 15px;
            }

            .vk-p2p-menu {
                position: fixed;
                z-index: 999999;
                box-sizing: border-box;
                width: min(340px, calc(100vw - 16px));
                max-width: calc(100vw - 16px);
                max-height: calc(100vh - 16px);
                overflow-y: auto;
                padding: 8px;
                border-radius: 14px;
                background: #ffffff;
                color: #111827;
                box-shadow: 0 18px 48px rgba(0,0,0,0.24);
                border: 1px solid rgba(0,0,0,0.10);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                font-size: 13px;
                animation: vkP2PFadeIn 0.12s ease-out;
            }

            .vk-p2p-menu-title {
                padding: 7px 9px 6px;
                color: #6b7280;
                font-size: 12px;
            }

            .vk-p2p-menu-item {
                display: block;
                width: 100%;
                border: none;
                background: transparent;
                color: inherit;
                text-align: left;
                padding: 9px 10px;
                border-radius: 9px;
                cursor: pointer;
                font: inherit;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                max-width: 100%;
            }

            .vk-p2p-menu-field {
                display: grid;
                gap: 6px;
                padding: 8px 10px;
            }

            .vk-p2p-menu-label {
                color: #4b5563;
                font-size: 12px;
            }

            .vk-p2p-menu-select {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid #d1d5db;
                border-radius: 9px;
                padding: 8px 10px;
                background: #fff;
                color: #111827;
                font: inherit;
            }

            .vk-p2p-menu-item:hover {
                background: #f3f4f6;
            }

            .vk-p2p-menu-item-active {
                background: #e8f1ff;
                color: #155aa3;
            }

            .vk-p2p-menu-sep {
                border-top: 1px solid #eef0f3;
                margin: 6px 0;
            }

            .vk-p2p-menu-danger {
                color: #b91c1c;
            }

            .vk-p2p-toast {
                position: fixed;
                left: 50%;
                bottom: 22px;
                transform: translateX(-50%);
                background: #1f2937;
                color: #fff;
                padding: 10px 14px;
                border-radius: 12px;
                font-size: 13px;
                z-index: 1000000;
                box-shadow: 0 8px 28px rgba(0,0,0,0.25);
                animation: vkP2PToastOut 2.4s forwards;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            }

            .vk-dec-content {
                white-space: pre-wrap;
            }

            .vk-dec-toggle {
                display: inline-block;
                margin-left: 8px;
                font-size: 11px;
                text-decoration: underline;
                cursor: pointer;
                opacity: 0.65;
                user-select: none;
                color: inherit;
            }

            .vk-dec-toggle:hover {
                opacity: 1;
            }

            .vk-dec-error {
                display: block;
                margin-top: 6px;
                font-size: 12px;
                line-height: 1.35;
                color: rgba(255, 255, 255, 0.72);
            }
        `;

        document.head.appendChild(style);
    }

    // ============================================================
    // UI helpers
    // ============================================================

    function showToast(text) {
        injectStyles();

        const old = document.querySelector('.vk-p2p-toast');
        if (old) old.remove();

        const toast = document.createElement('div');
        toast.className = 'vk-p2p-toast';
        toast.textContent = text;

        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);
    }

    function createModal({ title, bodyHtml, actionsHtml = '', closeOnOverlay = true }) {
        injectStyles();

        const overlay = document.createElement('div');
        overlay.className = 'vk-p2p-overlay';

        const modal = document.createElement('div');
        modal.className = 'vk-p2p-modal';

        modal.innerHTML = `
            <h3>${title}</h3>
            ${bodyHtml}
            ${actionsHtml ? `<div class="vk-p2p-actions">${actionsHtml}</div>` : ''}
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        if (closeOnOverlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) overlay.remove();
            });
        }

        return { overlay, modal };
    }

    function attachPasswordEye(input, eyeBtn) {
        eyeBtn.addEventListener('click', () => {
            input.type = input.type === 'password' ? 'text' : 'password';
            eyeBtn.textContent = input.type === 'password' ? '👁️' : '🙈';
            input.focus();
        });
    }

    function closeMenus() {
        document.querySelectorAll('.vk-p2p-menu').forEach(el => el.remove());
    }

    function truncateForDisplay(s, max = 16) {
        if (!s) return '';
        if (s.length <= max) return s;
        return s.slice(0, max - 2) + '..';
    }

    function formatKeyDisplay(slotId) {
        if (slotId === '@temp') return '⚡ @temp — временный';
        if (['k1', 'k2', 'k3', 'k4'].includes(slotId)) return `🔑 ${slotId}`;

        const label = getCustomKeyLabel(slotId);
        if (!label) return `🔑 ${slotId}`;
        return `🔑 ${slotId} (${truncateForDisplay(label)})`;
    }

    // ============================================================
    // Setup modal
    // ============================================================

    function showSeedSetupModal() {
        if (document.querySelector('.vk-p2p-overlay')) return;

        const { overlay, modal } = createModal({
            title: '🔐 Настройка VKEncrypt',
            closeOnOverlay: true,
            bodyHtml: `
                <p>
                    Введите секретное слово, число или фразу. Из неё будут созданы одинаковые ключи
                    <b>k1–k4</b> на всех устройствах, где введена та же фраза.
                </p>

                <p class="vk-p2p-note">
                    Лучше использовать длинную фразу из нескольких слов. Простые числа вроде <b>1234</b>
                    легко перебираются. Фраза не сохраняется — сохраняются только производные ключи.
                </p>

                <div class="vk-p2p-row">
                    <input class="vk-p2p-input" id="vk-p2p-seed-input" type="password"
                        placeholder="Например: длинная секретная фраза">
                    <button class="vk-p2p-btn vk-p2p-btn-secondary vk-p2p-eye-btn" id="vk-p2p-seed-eye" type="button">👁️</button>
                </div>

                <label class="vk-p2p-check">
                    <input id="vk-p2p-save-derived" type="checkbox" checked>
                    <span>Сохранить производные ключи на этом устройстве</span>
                </label>

                <label class="vk-p2p-check">
                    <input id="vk-p2p-auto-encrypt-first" type="checkbox">
                    <span>Включить автошифрование при отправке</span>
                </label>

                <label class="vk-p2p-check" for="vk-p2p-codec-first">
                    <span>Кодирование шифротекста</span>
                </label>
                <select class="vk-p2p-select" id="vk-p2p-codec-first">
                    <option value="emoji">Emoji</option>
                    <option value="cyrillic">Русский алфавит</option>
                    <option value="base64">Base64</option>
                </select>

                <p class="vk-p2p-error" id="vk-p2p-seed-error"></p>
            `,
            actionsHtml: `
                <button class="vk-p2p-btn vk-p2p-btn-secondary" id="vk-p2p-seed-temp">
                    Только на эту сессию
                </button>
                <button class="vk-p2p-btn vk-p2p-btn-primary" id="vk-p2p-seed-apply">
                    Создать ключи
                </button>
            `
        });

        const input = modal.querySelector('#vk-p2p-seed-input');
        const eyeBtn = modal.querySelector('#vk-p2p-seed-eye');
        const error = modal.querySelector('#vk-p2p-seed-error');
        const saveCheckbox = modal.querySelector('#vk-p2p-save-derived');
        const autoCheckbox = modal.querySelector('#vk-p2p-auto-encrypt-first');
        const codecSelect = modal.querySelector('#vk-p2p-codec-first');
        const applyBtn = modal.querySelector('#vk-p2p-seed-apply');
        const tempBtn = modal.querySelector('#vk-p2p-seed-temp');

        autoCheckbox.checked = settings.autoEncrypt;
        codecSelect.value = normalizeCodecId(settings.cipherCodec);

        attachPasswordEye(input, eyeBtn);

        setTimeout(() => input.focus(), 80);

        async function applySeed(saveMode) {
            const seed = input.value.trim();

            if (seed.length < 6) {
                error.textContent = 'Слишком коротко. Лучше минимум 12 символов или несколько слов.';
                error.style.display = 'block';
                return;
            }

            error.style.display = 'none';
            applyBtn.disabled = true;
            tempBtn.disabled = true;
            applyBtn.textContent = 'Создаю...';

            try {
                const keys = await deriveKeyMaterialFromSeed(seed);

                DERIVED_KEYS = keys;
                currentKeySlot = DEFAULT_KEY_SLOT;

                settings.autoEncrypt = Boolean(autoCheckbox.checked);
                settings.cipherCodec = normalizeCodecId(codecSelect.value);
                settings.saveDerivedKeys = Boolean(saveMode);
                saveSettings();

                if (saveMode) saveDerivedKeys(keys);

                overlay.remove();
                updateEncryptButtonsTitle();
                scan();

                showToast(saveMode ? '✅ Ключи созданы и сохранены' : '✅ Ключи созданы до перезагрузки страницы');
            } catch (err) {
                error.textContent = 'Ошибка генерации ключей: ' + err.message;
                error.style.display = 'block';
            } finally {
                applyBtn.disabled = false;
                tempBtn.disabled = false;
                applyBtn.textContent = 'Создать ключи';
            }
        }

        applyBtn.addEventListener('click', () => applySeed(saveCheckbox.checked));
        tempBtn.addEventListener('click', () => applySeed(false));

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applySeed(saveCheckbox.checked);
            }
        });
    }

    // ============================================================
    // Custom key modals
    // ============================================================

    function showAddCustomKeyModal() {
        const { overlay, modal } = createModal({
            title: '➕ Пользовательский ключ',
            bodyHtml: `
                <p>
                    Введи имя для слота и <b>64 hex-символа</b> — или просто любое слово
                    (например, «собака»). Из слова скрипт детерминированно выведет
                    256-битный ключ. Собеседнику нужно ввести то же слово.
                </p>

                <input class="vk-p2p-input" id="vk-p2p-custom-name"
                    placeholder="Имя слота, например k5, друг или friend1">

                <div style="height:8px"></div>

                <textarea class="vk-p2p-textarea" id="vk-p2p-custom-key"
                    placeholder="64 hex-символа ИЛИ любое слово: собака, мой-друг, ..."></textarea>

                <p class="vk-p2p-note">
                    Имя слота может быть и на кириллице. Подходят буквы любого алфавита, цифры, _, -, . и @.
                </p>

                <p class="vk-p2p-error" id="vk-p2p-custom-error"></p>
            `,
            actionsHtml: `
                <button class="vk-p2p-btn vk-p2p-btn-secondary" id="vk-p2p-custom-cancel">Отмена</button>
                <button class="vk-p2p-btn vk-p2p-btn-primary" id="vk-p2p-custom-save">Сохранить</button>
            `
        });

        const nameInput = modal.querySelector('#vk-p2p-custom-name');
        const keyInput = modal.querySelector('#vk-p2p-custom-key');
        const error = modal.querySelector('#vk-p2p-custom-error');
        const saveBtn = modal.querySelector('#vk-p2p-custom-save');
        const cancelBtn = modal.querySelector('#vk-p2p-custom-cancel');

        setTimeout(() => nameInput.focus(), 80);

        cancelBtn.addEventListener('click', () => overlay.remove());

        async function handleSave() {
            let name = nameInput.value.trim();
            const keyOrWord = keyInput.value.trim();

            if (!name) {
                error.textContent = 'Введите имя ключа.';
                error.style.display = 'block';
                return;
            }

            name = name.replace(/\s+/g, '_');

            if (['k1', 'k2', 'k3', 'k4', '@temp'].includes(name)) {
                error.textContent = 'Это имя зарезервировано. Используй другое.';
                error.style.display = 'block';
                return;
            }

            if (!/^[\p{L}\p{N}_.@-]{1,32}$/u.test(name)) {
                error.textContent = 'Имя может содержать буквы любого алфавита, цифры, _, -, . и @. До 32 символов.';
                error.style.display = 'block';
                return;
            }

            if (!keyOrWord) {
                error.textContent = 'Введите 64 hex-символа или любое слово.';
                error.style.display = 'block';
                return;
            }

            saveBtn.disabled = true;
            saveBtn.textContent = 'Создаю...';

            try {
                let keyHex;
                let label = '';

                if (isValidKeyHex(keyOrWord)) {
                    keyHex = keyOrWord.toLowerCase();
                } else {
                    keyHex = await deriveKeyFromName(keyOrWord);
                    label = keyOrWord;
                }

                CUSTOM_KEYS[name] = { key: keyHex, label };
                saveCustomKeys();
                currentKeySlot = name;

                overlay.remove();
                updateEncryptButtonsTitle();
                scan();

                const tag = label ? ` «${truncateForDisplay(label, 24)}»` : '';
                showToast(`✅ ${name}${tag} сохранён`);
            } catch (err) {
                error.textContent = 'Ошибка: ' + err.message;
                error.style.display = 'block';
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Сохранить';
            }
        }

        saveBtn.addEventListener('click', handleSave);

        keyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSave();
            }
        });
    }

    async function generateTempKey() {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const keyHex = bytesToHex(bytes);

        TEMP_KEY = keyHex;
        currentKeySlot = '@temp';

        updateEncryptButtonsTitle();
        scan();

        try {
            await navigator.clipboard.writeText(keyHex);
            showToast('✅ Временный ключ создан и скопирован');
        } catch {
            showGeneratedKeyModal(keyHex);
        }
    }

    function showGeneratedKeyModal(keyHex) {
        const { overlay, modal } = createModal({
            title: '⚡ Новый временный ключ',
            bodyHtml: `
                <p>
                    Ключ создан и применён. Скопируй его и передай собеседнику.
                    Он исчезнет при перезагрузке страницы.
                </p>

                <textarea class="vk-p2p-textarea" id="vk-p2p-generated-key" readonly>${keyHex}</textarea>
            `,
            actionsHtml: `
                <button class="vk-p2p-btn vk-p2p-btn-secondary" id="vk-p2p-generated-close">Закрыть</button>
                <button class="vk-p2p-btn vk-p2p-btn-primary" id="vk-p2p-generated-copy">Скопировать</button>
            `
        });

        const output = modal.querySelector('#vk-p2p-generated-key');

        setTimeout(() => {
            output.focus();
            output.select();
        }, 80);

        modal.querySelector('#vk-p2p-generated-close').addEventListener('click', () => overlay.remove());

        modal.querySelector('#vk-p2p-generated-copy').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(keyHex);
                overlay.remove();
                showToast('✅ Ключ скопирован');
            } catch {
                output.focus();
                output.select();
            }
        });
    }

    function showSeedChangeModal() {
        const { overlay, modal } = createModal({
            title: '🔄 Сменить seed-фразу',
            bodyHtml: `
                <p>
                    Будут заново созданы ключи <b>k1–k4</b>. Старые сохранённые k1–k4 будут заменены.
                    Пользовательские ключи не удаляются.
                </p>

                <div class="vk-p2p-row">
                    <input class="vk-p2p-input" id="vk-p2p-change-seed-input" type="password"
                        placeholder="Новая секретная фраза">
                    <button class="vk-p2p-btn vk-p2p-btn-secondary vk-p2p-eye-btn" id="vk-p2p-change-seed-eye" type="button">👁️</button>
                </div>

                <label class="vk-p2p-check">
                    <input id="vk-p2p-change-save" type="checkbox" checked>
                    <span>Сохранить производные ключи на этом устройстве</span>
                </label>

                <p class="vk-p2p-error" id="vk-p2p-change-seed-error"></p>
            `,
            actionsHtml: `
                <button class="vk-p2p-btn vk-p2p-btn-secondary" id="vk-p2p-change-cancel">Отмена</button>
                <button class="vk-p2p-btn vk-p2p-btn-primary" id="vk-p2p-change-apply">Сменить</button>
            `
        });

        const input = modal.querySelector('#vk-p2p-change-seed-input');
        const eyeBtn = modal.querySelector('#vk-p2p-change-seed-eye');
        const error = modal.querySelector('#vk-p2p-change-seed-error');
        const saveCheckbox = modal.querySelector('#vk-p2p-change-save');
        const applyBtn = modal.querySelector('#vk-p2p-change-apply');

        attachPasswordEye(input, eyeBtn);

        setTimeout(() => input.focus(), 80);

        modal.querySelector('#vk-p2p-change-cancel').addEventListener('click', () => overlay.remove());

        async function apply() {
            const seed = input.value.trim();

            if (seed.length < 6) {
                error.textContent = 'Слишком коротко. Лучше минимум 12 символов или несколько слов.';
                error.style.display = 'block';
                return;
            }

            applyBtn.disabled = true;
            applyBtn.textContent = 'Создаю...';

            try {
                const keys = await deriveKeyMaterialFromSeed(seed);
                DERIVED_KEYS = keys;
                currentKeySlot = DEFAULT_KEY_SLOT;

                if (saveCheckbox.checked) {
                    saveDerivedKeys(keys);
                } else {
                    clearDerivedKeys();
                    DERIVED_KEYS = keys;
                }

                settings.saveDerivedKeys = Boolean(saveCheckbox.checked);
                saveSettings();

                overlay.remove();
                updateEncryptButtonsTitle();
                scan();

                showToast('✅ Seed-фраза сменена');
            } catch (err) {
                error.textContent = 'Ошибка: ' + err.message;
                error.style.display = 'block';
            } finally {
                applyBtn.disabled = false;
                applyBtn.textContent = 'Сменить';
            }
        }

        applyBtn.addEventListener('click', apply);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                apply();
            }
        });
    }

    // ============================================================
    // Incoming decrypt
    // ============================================================

    function createToggleInterface(originalEnc, decryptedText, parentEl) {
        parentEl.innerHTML = '';

        const textSpan = document.createElement('span');
        textSpan.className = 'vk-dec-content';
        textSpan.dataset.vkdecSkip = 'true';
        textSpan.textContent = decryptedText;
        textSpan.style.fontWeight = 'normal';

        const toggleLink = document.createElement('a');
        toggleLink.href = '#';
        toggleLink.className = 'vk-dec-toggle';
        toggleLink.dataset.vkdecSkip = 'true';
        toggleLink.textContent = '[шифр]';
        toggleLink.title = 'Показать зашифрованный оригинал';

        toggleLink.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (toggleLink.textContent === '[шифр]') {
                textSpan.textContent = originalEnc;
                textSpan.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
                toggleLink.textContent = '[текст]';
            } else {
                textSpan.textContent = decryptedText;
                textSpan.style.fontFamily = '';
                toggleLink.textContent = '[шифр]';
            }
        });

        parentEl.appendChild(textSpan);
        parentEl.appendChild(document.createTextNode(' '));
        parentEl.appendChild(toggleLink);

        parentEl.dataset.vkdecDone = 'true';
    }

    function createErrorInterface(originalEnc, errorText, parentEl) {
        parentEl.innerHTML = '';

        const rawSpan = document.createElement('span');
        rawSpan.className = 'vk-dec-content';
        rawSpan.dataset.vkdecSkip = 'true';
        rawSpan.textContent = originalEnc;

        const errorLine = document.createElement('span');
        errorLine.className = 'vk-dec-error';
        errorLine.dataset.vkdecSkip = 'true';
        errorLine.textContent = `ошибка: ${errorText}`;

        parentEl.appendChild(rawSpan);
        parentEl.appendChild(errorLine);
        parentEl.dataset.vkdecDone = 'true';
    }

    function extractNodeText(node) {
        if (!node) return '';

        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent || '';
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return '';
        }

        const el = /** @type {HTMLElement} */ (node);

        if (el.dataset?.vkdecSkip === 'true') {
            return '';
        }

        if (el.tagName === 'IMG') {
            return el.getAttribute('alt') || '';
        }

        let out = '';
        el.childNodes.forEach(child => {
            out += extractNodeText(child);
        });
        return out;
    }

    function extractMessageText(msgEl) {
        return extractNodeText(msgEl).trim();
    }

    async function processIncomingMessage(msgEl) {
        if (!settings.autoDecrypt) return;
        if (!hasAnyKeys()) return;
        if (msgEl.dataset.vkdecDone) return;

        const text = extractMessageText(msgEl);
        const parsed = parseEncryptedMessage(text);
        if (!parsed) return;

        const keyHex = getAllKeys()[parsed.keyId];

        if (!keyHex) {
            console.warn(`🔑 Ключ "${parsed.keyId}" не найден`);
            return;
        }

        try {
            const payload = decodePayloadForCodec(parsed.encodedPayload, parsed.codecId);
            const decrypted = await decryptAESGCM(payload, keyHex);
            createToggleInterface(parsed.originalText, decrypted, msgEl);
        } catch (err) {
            console.error('❌ Ошибка расшифровки:', err);
            createErrorInterface(parsed.originalText, err.message, msgEl);
        }
    }

    function getIncomingMessageElements() {
        const elements = new Set();

        document.querySelectorAll(
            '.ConvoMessage__text, .MessageText, .im_msg_text, .im-message--text'
        ).forEach(el => {
            if (el.closest('[data-vkdec-done="true"]')) return;
            elements.add(el);
        });

        document.querySelectorAll('[role="list"][aria-label*="Сообщения"]').forEach(list => {
            list.querySelectorAll('article span, article div').forEach(el => {
                if (el.dataset.vkdecSkip === 'true') return;
                if (el.closest('[data-vkdec-done="true"]')) return;
                if (el.children.length) return;

                const text = extractMessageText(el);
                if (parseEncryptedMessage(text)) {
                    elements.add(el);
                }
            });
        });

        return elements;
    }

    // ============================================================
    // Composer helpers
    // ============================================================

    function getComposerInput() {
        const selectors = [
            '.ComposerInput__input.ConvoComposer__input[contenteditable="true"]',
            '.ConvoComposer__input[contenteditable="true"]',
            '.im-editable[contenteditable="true"]',
            '[contenteditable="true"][role="textbox"]',
            '[contenteditable="true"]'
        ];

        for (const selector of selectors) {
            const list = Array.from(document.querySelectorAll(selector));
            const visible = list.find(el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 20 && rect.height > 10;
            });

            if (visible) return visible;
        }

        return null;
    }

    function getComposerPanel(inputEl) {
        if (!inputEl) return null;

        const knownPanel = inputEl.closest(
            '.ConvoComposer__inputPanel, .ConvoComposer, .im-compose, .im-chat-input, form'
        );

        if (knownPanel) return knownPanel;

        let node = inputEl.parentElement;

        while (node && node !== document.body) {
            const rect = node.getBoundingClientRect();
            const hasComposerButtons = Boolean(node.querySelector(
                'button, [role="button"], [aria-label*="Загрузить файл"], [aria-label*="эмодзи"], [aria-label*="голосового"]'
            ));

            if (hasComposerButtons && rect.width > 80 && rect.height > 20) {
                return node;
            }

            node = node.parentElement;
        }

        return inputEl.parentElement;
    }

    function findSendButton(panel) {
        const root = panel || document;

        const selectors = [
            '.ConvoComposer__buttonIcon--submit',
            'button[aria-label*="Отправить"]',
            '[aria-label*="Отправить"]',
            'button[type="submit"]',
            '.im-send-btn',
            '.ConvoComposer__button:last-child'
        ];

        for (const selector of selectors) {
            const found = root.querySelector(selector);
            if (!found) continue;

            const button = found.closest('button, [role="button"], a, div') || found;
            const rect = button.getBoundingClientRect();

            if (rect.width > 0 && rect.height > 0) {
                return button;
            }
        }

        const icon = root.querySelector('svg.vkuiIcon--send_24, .vkuiIcon--send_24');
        if (icon) {
            return icon.closest('button, [role="button"], a, div') || icon;
        }

        return null;
    }

    function getComposerInsertReference(panel, inputEl) {
        if (!panel || !inputEl) return null;

        let node = inputEl;

        while (node.parentElement && node.parentElement !== panel) {
            node = node.parentElement;
        }

        return node.parentElement === panel ? node : inputEl;
    }

    function getInputPlainText(inputEl) {
        if (!inputEl) return '';

        if ('value' in inputEl) {
            return inputEl.value.trim();
        }

        return inputEl.innerText.trim();
    }

    function setInputPlainText(inputEl, text) {
        if (!inputEl) return;

        inputEl.focus();

        if ('value' in inputEl) {
            inputEl.value = text;
        } else {
            inputEl.innerText = text;

            const range = document.createRange();
            const sel = window.getSelection();

            range.selectNodeContents(inputEl);
            range.collapse(false);

            sel.removeAllRanges();
            sel.addRange(range);
        }

        inputEl.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: text
        }));

        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function encryptCurrentInput({ showErrors = true } = {}) {
        if (!hasAnyKeys()) {
            showSeedSetupModal();
            return false;
        }

        const inputEl = getComposerInput();

        if (!inputEl) {
            if (showErrors) showToast('❌ Не нашёл поле ввода');
            return false;
        }

        const plainText = getInputPlainText(inputEl);

        if (!plainText) return false;

        if (parseEncryptedMessage(plainText)) {
            return true;
        }

        const keyHex = getCurrentKeyHex();

        if (!keyHex) {
            if (showErrors) showToast(`❌ Ключ "${currentKeySlot}" не найден`);
            return false;
        }

        try {
            const b64 = await encryptAESGCM(plainText, keyHex);
            const codecId = normalizeCodecId(settings.cipherCodec);
            const payload = encodePayloadForCodec(b64, codecId);
            const encryptedMsg = formatEncryptedMessage(currentKeySlot, payload, codecId);

            setInputPlainText(inputEl, encryptedMsg);
            lastEncryptedAt = Date.now();

            return true;
        } catch (err) {
            console.error('❌ Ошибка шифрования:', err);
            if (showErrors) showToast('❌ Не удалось зашифровать: ' + err.message);
            return false;
        }
    }

    async function autoEncryptAndSend(event) {
        if (!settings.autoEncrypt) return;
        if (isAutoSending) return;

        if (!hasAnyKeys()) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
            }
            showSeedSetupModal();
            return;
        }

        const inputEl = getComposerInput();
        if (!inputEl) return;

        const plainText = getInputPlainText(inputEl);
        if (!plainText) return;

        if (parseEncryptedMessage(plainText)) {
            return;
        }

        if (event) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
        }

        const ok = await encryptCurrentInput({ showErrors: true });
        if (!ok) return;

        isAutoSending = true;

        setTimeout(() => {
            try {
                const freshInput = getComposerInput();
                const panel = getComposerPanel(freshInput);
                const sendBtn = findSendButton(panel);

                if (sendBtn) {
                    sendBtn.click();
                } else {
                    showToast('⚠️ Зашифровал, но не нашёл кнопку отправки');
                }
            } finally {
                setTimeout(() => {
                    isAutoSending = false;
                }, 300);
            }
        }, 120);
    }

    function handleComposerKeydown(e) {
        if (!settings.autoEncrypt) return;
        if (e.key !== 'Enter') return;

        // Shift+Enter оставляем для переноса строки.
        if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;

        autoEncryptAndSend(e);
    }

    function attachEnterHandler(inputEl) {
        if (!inputEl || inputEl.dataset.vkP2PEnterAttached === 'true') return;

        inputEl.dataset.vkP2PEnterAttached = 'true';
        inputEl.addEventListener('keydown', handleComposerKeydown, true);
    }

    function attachSendButtonHandler(sendBtn) {
        if (!sendBtn || sendBtn.dataset.vkP2PSendAttached === 'true') return;

        sendBtn.dataset.vkP2PSendAttached = 'true';

        sendBtn.addEventListener('click', (e) => {
            if (!settings.autoEncrypt) return;
            if (isAutoSending) return;

            const now = Date.now();

            // Если только что зашифровали вручную, не мешаем отправке.
            if (now - lastEncryptedAt < 250) return;

            autoEncryptAndSend(e);
        }, true);
    }

    // ============================================================
    // Composer controls
    // ============================================================

    function updateEncryptButtonsTitle() {
        const encBtn = document.getElementById('vk-p2p-enc-btn');
        const keyBtn = document.getElementById('vk-p2p-key-btn');
        const hasKeys = hasAnyKeys();

        if (encBtn) {
            encBtn.title = hasKeys
                ? `Зашифровать сообщение. Ключ: ${currentKeySlot}`
                : 'Настроить ключи VKEncrypt';

            encBtn.textContent = hasKeys ? '🔒' : '🔐';
            encBtn.style.opacity = hasKeys ? '0.58' : '0.35';
            encBtn.style.display = settings.autoEncrypt && hasKeys ? 'none' : '';
        }

        if (keyBtn) {
            keyBtn.title = hasKeys
                ? `Настройки VKEncrypt. Сейчас: ${currentKeySlot}`
                : 'Настроить VKEncrypt';

            keyBtn.textContent = !hasKeys
                ? '⚙️'
                : currentKeySlot === '@temp'
                    ? '⚡'
                    : settings.autoEncrypt
                        ? '🟢'
                        : '🔑';
        }
    }

    function addEncryptButton() {
        const inputEl = getComposerInput();
        if (!inputEl) return;

        attachEnterHandler(inputEl);

        const panel = getComposerPanel(inputEl);
        if (!panel) return;

        const sendBtn = findSendButton(panel);
        if (sendBtn) attachSendButtonHandler(sendBtn);

        if (document.getElementById('vk-p2p-enc-controls')) {
            updateEncryptButtonsTitle();
            return;
        }

        const wrapper = document.createElement('span');
        wrapper.id = 'vk-p2p-enc-controls';
        wrapper.className = 'vk-p2p-controls';

        const encBtn = document.createElement('button');
        encBtn.id = 'vk-p2p-enc-btn';
        encBtn.className = 'vk-p2p-icon-btn vk-p2p-icon-btn-main';
        encBtn.type = 'button';
        encBtn.textContent = '🔒';

        const keyBtn = document.createElement('button');
        keyBtn.id = 'vk-p2p-key-btn';
        keyBtn.className = 'vk-p2p-icon-btn vk-p2p-icon-btn-small';
        keyBtn.type = 'button';

        encBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (!hasAnyKeys()) {
                showSeedSetupModal();
                return;
            }

            encBtn.disabled = true;
            encBtn.textContent = '⏳';

            try {
                const ok = await encryptCurrentInput({ showErrors: true });
                if (ok) showToast('✅ Сообщение зашифровано');
            } finally {
                encBtn.disabled = false;
                encBtn.textContent = '🔒';
                updateEncryptButtonsTitle();
            }
        });

        keyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (!hasAnyKeys()) {
                showSeedSetupModal();
                return;
            }

            showMainMenu(keyBtn);
        });

        wrapper.appendChild(encBtn);
        wrapper.appendChild(keyBtn);

        const insertReference = getComposerInsertReference(panel, inputEl);

        if (sendBtn?.parentNode && panel.contains(sendBtn)) {
            sendBtn.parentNode.insertBefore(wrapper, sendBtn);
        } else if (insertReference?.parentNode) {
            insertReference.parentNode.insertBefore(wrapper, insertReference.nextSibling);
        } else {
            panel.appendChild(wrapper);
        }

        updateEncryptButtonsTitle();
    }

    function showMainMenu(anchorBtn) {
        closeMenus();

        const menu = document.createElement('div');
        menu.className = 'vk-p2p-menu';
        menu.style.left = '8px';
        menu.style.top = '8px';
        menu.style.visibility = 'hidden';

        const title = document.createElement('div');
        title.className = 'vk-p2p-menu-title';
        title.textContent = `${APP_NAME} v${APP_VERSION}`;
        menu.appendChild(title);

        const allKeys = getAllKeys();
        const keyNames = Object.keys(allKeys);

        if (keyNames.length) {
            const keyTitle = document.createElement('div');
            keyTitle.className = 'vk-p2p-menu-title';
            keyTitle.textContent = 'Ключ шифрования';
            menu.appendChild(keyTitle);

            keyNames.forEach(slotId => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'vk-p2p-menu-item';

                if (slotId === currentKeySlot) {
                    item.classList.add('vk-p2p-menu-item-active');
                }

                item.textContent = formatKeyDisplay(slotId);
                item.title = slotId === '@temp'
                    ? 'Временный ключ (только в памяти)'
                    : getCustomKeyLabel(slotId)
                        ? `${slotId} — ${getCustomKeyLabel(slotId)}`
                        : slotId;

                item.addEventListener('click', () => {
                    currentKeySlot = slotId;
                    closeMenus();
                    updateEncryptButtonsTitle();
                    showToast(`✅ Выбран ключ: ${formatKeyDisplay(slotId)}`);
                });

                menu.appendChild(item);
            });
        }

        addMenuSeparator(menu);

        addMenuItem(menu, settings.autoEncrypt ? '🟢 Автошифрование: включено' : '⚪ Автошифрование: выключено', () => {
            settings.autoEncrypt = !settings.autoEncrypt;
            saveSettings();
            closeMenus();
            updateEncryptButtonsTitle();
            scan();
            showToast(settings.autoEncrypt ? '✅ Автошифрование включено' : '⏸️ Автошифрование выключено');
        });

        addMenuSelect(
            menu,
            'Кодирование шифротекста',
            'vk-p2p-cipher-codec-select',
            normalizeCodecId(settings.cipherCodec),
            [
                { value: 'emoji', label: 'Emoji' },
                { value: 'cyrillic', label: 'Русский алфавит' },
                { value: 'base64', label: 'Base64' }
            ],
            value => {
                settings.cipherCodec = normalizeCodecId(value);
                saveSettings();
                showToast(`✅ Новые сообщения будут в формате: ${getCipherCodecConfig(settings.cipherCodec).label}`);
            }
        );

        addMenuItem(menu, settings.autoDecrypt ? '👁️ Авто-расшифровка: включена' : '🙈 Авто-расшифровка: выключена', () => {
            settings.autoDecrypt = !settings.autoDecrypt;
            saveSettings();
            closeMenus();
            showToast(settings.autoDecrypt ? '✅ Авто-расшифровка включена' : '⏸️ Авто-расшифровка выключена');
            scan();
        });

        addMenuSeparator(menu);

        addMenuItem(menu, '➕ Добавить пользовательский ключ', () => {
            closeMenus();
            showAddCustomKeyModal();
        });

        addMenuItem(menu, '⚡ Сгенерировать временный ключ', () => {
            closeMenus();
            generateTempKey();
        });

        addMenuItem(menu, '🔄 Сменить seed-фразу k1–k4', () => {
            closeMenus();
            showSeedChangeModal();
        });

        if (TEMP_KEY) {
            addMenuItem(menu, '🧹 Удалить временный ключ', () => {
                TEMP_KEY = null;
                if (currentKeySlot === '@temp') currentKeySlot = DEFAULT_KEY_SLOT;
                closeMenus();
                updateEncryptButtonsTitle();
                showToast('✅ Временный ключ удалён');
            });
        }

        const customKeyNames = Object.keys(CUSTOM_KEYS);
        if (customKeyNames.length) {
            addMenuSeparator(menu);

            customKeyNames.forEach(name => {
                const label = getCustomKeyLabel(name);
                const display = label
                    ? `${name} (${truncateForDisplay(label)})`
                    : name;

                addMenuItem(menu, `🗑️ Удалить ключ ${display}`, () => {
                    if (!confirm(`Удалить пользовательский ключ "${name}"?`)) return;

                    delete CUSTOM_KEYS[name];
                    saveCustomKeys();

                    if (currentKeySlot === name) currentKeySlot = DEFAULT_KEY_SLOT;

                    closeMenus();
                    updateEncryptButtonsTitle();
                    showToast(`✅ Ключ ${name} удалён`);
                }, true);
            });
        }

        addMenuSeparator(menu);

        addMenuItem(menu, '🧨 Сбросить все сохранённые ключи', () => {
            if (!confirm('Удалить сохранённые k1–k4 и все пользовательские ключи?')) return;

            closeMenus();
            resetAllKeys();
            showToast('✅ Сохранённые ключи сброшены');
        }, true);

        document.body.appendChild(menu);
        positionMenu(menu, anchorBtn);

        setTimeout(() => {
            document.addEventListener('click', function closeOnce(e) {
                if (!menu.contains(e.target) && e.target !== anchorBtn) {
                    menu.remove();
                }
            }, { once: true });
        }, 0);
    }

    function addMenuItem(menu, text, onClick, danger = false) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'vk-p2p-menu-item';

        if (danger) item.classList.add('vk-p2p-menu-danger');

        item.textContent = text;
        item.addEventListener('click', onClick);

        menu.appendChild(item);
        return item;
    }

    function addMenuSelect(menu, label, id, value, options, onChange) {
        const field = document.createElement('div');
        field.className = 'vk-p2p-menu-field';

        const labelEl = document.createElement('label');
        labelEl.className = 'vk-p2p-menu-label';
        labelEl.htmlFor = id;
        labelEl.textContent = label;

        const select = document.createElement('select');
        select.className = 'vk-p2p-menu-select';
        select.id = id;

        options.forEach(option => {
            const item = document.createElement('option');
            item.value = option.value;
            item.textContent = option.label;
            select.appendChild(item);
        });

        select.value = value;
        select.addEventListener('change', () => onChange(select.value));

        field.appendChild(labelEl);
        field.appendChild(select);
        menu.appendChild(field);
        return select;
    }

    function addMenuSeparator(menu) {
        const sep = document.createElement('div');
        sep.className = 'vk-p2p-menu-sep';
        menu.appendChild(sep);
    }

    function positionMenu(menu, anchorBtn) {
        const rect = anchorBtn.getBoundingClientRect();
        const margin = 8;
        const availableHeight = window.innerHeight - margin * 2;

        menu.style.maxHeight = `${availableHeight}px`;

        const menuRect = menu.getBoundingClientRect();
        const width = menuRect.width;
        const height = Math.min(menuRect.height, availableHeight);

        if (menuRect.height > availableHeight) {
            menu.style.height = `${availableHeight}px`;
        } else {
            menu.style.height = '';
        }
        const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
        const preferredTop = rect.top - height - margin;
        const fallbackTop = rect.bottom + margin;
        const top = preferredTop >= margin
            ? preferredTop
            : Math.min(fallbackTop, window.innerHeight - height - margin);

        menu.style.left = `${left}px`;
        menu.style.top = `${Math.max(margin, top)}px`;
        menu.style.visibility = 'visible';
    }

    // ============================================================
    // Scan loop
    // ============================================================

    function scan() {
        injectStyles();

        getIncomingMessageElements().forEach(el => processIncomingMessage(el));

        addEncryptButton();
    }

    function scheduleScan(delay = 250) {
        if (scanTimer !== null) return;

        scanTimer = setTimeout(() => {
            scanTimer = null;
            scan();
        }, delay);
    }

    function init() {
        injectStyles();

        loadSettings();
        loadCustomKeys();

        DERIVED_KEYS = loadDerivedKeys();

        if (!DERIVED_KEYS && Object.keys(CUSTOM_KEYS).length) {
            currentKeySlot = Object.keys(CUSTOM_KEYS)[0];
        }

        console.log(`🔐 ${APP_NAME} v${APP_VERSION} loaded`);
        console.log('🔑 Derived keys:', DERIVED_KEYS ? 'yes' : 'no');
        console.log('🔑 Custom keys:', Object.keys(CUSTOM_KEYS).join(', ') || 'none');
        console.log('⚡ Temp key:', TEMP_KEY ? 'yes' : 'no');

        scheduleScan(700);

        const observer = new MutationObserver(() => {
            scheduleScan();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeMenus();
            }
        }, true);
    }

    init();

})();
