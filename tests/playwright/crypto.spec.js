// Чисто-Node криптотесты: KDF, AES-GCM roundtrip, emoji-кодирование.
// Браузер не нужен — крутится всё на node:crypto.
const { test, expect } = require('@playwright/test');
const crypto = require('crypto');

const KDF_SALT = 'vk-p2p-aes-gcm-v1';
const KDF_ITERATIONS = 250_000;
const IV_LEN = 12;
const TAG_LEN = 16;

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
    'ш','щ','ъ','ы','ь','э','ю','я'
];
const FORMAT_START = '𓁗';
const FORMAT_MID = 'Ⰴ';
const FORMAT_PAYLOAD = 'Ⱑ';
const CODEC_MARKERS = {
    base64: '𐌁',
    emoji: '𐌄',
    cyrillic: '𐌓',
};

function deriveKeyMaterialFromSeed(seed) {
    const derived = crypto.pbkdf2Sync(seed, KDF_SALT, KDF_ITERATIONS, 128, 'sha256');
    return {
        k1: derived.subarray(0, 32).toString('hex'),
        k2: derived.subarray(32, 64).toString('hex'),
        k3: derived.subarray(64, 96).toString('hex'),
        k4: derived.subarray(96, 128).toString('hex'),
    };
}

function aesGcmEncrypt(plainText, keyHex) {
    const key = Buffer.from(keyHex, 'hex');
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ct, tag]).toString('base64');
}

function aesGcmDecrypt(b64Payload, keyHex) {
    const buf = Buffer.from(b64Payload, 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
    const key = Buffer.from(keyHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function encodeBase64ToEmoji(b64) {
    let out = '';
    for (const ch of b64) {
        if (ch === '=') { continue; }
        const idx = BASE64_ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error('Invalid base64: ' + ch);
        out += EMOJI_ALPHABET[idx];
    }
    return out;
}

function decodeEmojiToBase64(payload) {
    const body = Array.from(payload);
    let out = '';
    for (const ch of body) {
        if (ch === EMOJI_PAD) { out += '='; continue; }
        const idx = EMOJI_ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error('Invalid emoji: ' + ch);
        out += BASE64_ALPHABET[idx];
    }
    return out + '='.repeat((4 - (out.length % 4)) % 4);
}

function encodeBase64ToCyrillic(b64) {
    let out = '';
    for (const ch of b64) {
        if (ch === '=') { continue; }
        const idx = BASE64_ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error('Invalid base64: ' + ch);
        out += CYRILLIC_ALPHABET[idx];
    }
    return out;
}

function decodeCyrillicToBase64(payload) {
    let out = '';
    for (const ch of Array.from(payload)) {
        const idx = CYRILLIC_ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error('Invalid cyrillic: ' + ch);
        out += BASE64_ALPHABET[idx];
    }
    return out + '='.repeat((4 - (out.length % 4)) % 4);
}

test.describe('KDF (PBKDF2-SHA256 / 250k / salt vk-p2p-aes-gcm-v1)', () => {
    test('одна фраза → одинаковые k1..k4', () => {
        const a = deriveKeyMaterialFromSeed('длинная секретная фраза');
        const b = deriveKeyMaterialFromSeed('длинная секретная фраза');
        expect(a).toEqual(b);
    });

    test('разные фразы → разные ключи', () => {
        const a = deriveKeyMaterialFromSeed('фраза 1');
        const b = deriveKeyMaterialFromSeed('фраза 2');
        expect(a.k1).not.toBe(b.k1);
    });

    test('каждый ключ = 64 hex (256 бит)', () => {
        const k = deriveKeyMaterialFromSeed('тест');
        for (const v of Object.values(k)) {
            expect(v).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    test('4 ключа попарно различны', () => {
        const k = deriveKeyMaterialFromSeed('тест');
        const vals = Object.values(k);
        expect(new Set(vals).size).toBe(4);
    });
});

test.describe('AES-256-GCM', () => {
    test('roundtrip текст', () => {
        const k = deriveKeyMaterialFromSeed('тест').k1;
        const enc = aesGcmEncrypt('Привет, мир! 🦊', k);
        expect(aesGcmDecrypt(enc, k)).toBe('Привет, мир! 🦊');
    });

    test('roundtrip пустая строка', () => {
        const k = deriveKeyMaterialFromSeed('тест').k1;
        const enc = aesGcmEncrypt('', k);
        expect(aesGcmDecrypt(enc, k)).toBe('');
    });

    test('roundtrip длинный текст', () => {
        const k = deriveKeyMaterialFromSeed('тест').k1;
        const long = 'A'.repeat(10_000);
        const enc = aesGcmEncrypt(long, k);
        expect(aesGcmDecrypt(enc, k)).toBe(long);
    });

    test('неправильный ключ → GCM tag mismatch', () => {
        const k1 = deriveKeyMaterialFromSeed('фраза 1').k1;
        const k2 = deriveKeyMaterialFromSeed('фраза 2').k1;
        const enc = aesGcmEncrypt('secret', k1);
        expect(() => aesGcmDecrypt(enc, k2)).toThrow();
    });

    test('подмена ciphertext ломает GCM-тег', () => {
        const k = deriveKeyMaterialFromSeed('тест').k1;
        const enc = aesGcmEncrypt('secret', k);
        const buf = Buffer.from(enc, 'base64');
        buf[buf.length - 5] ^= 0x01;
        expect(() => aesGcmDecrypt(buf.toString('base64'), k)).toThrow();
    });
});

test.describe('emoji-кодирование', () => {
    test('Base64 → emoji → Base64 обратимо', () => {
        const samples = [
            'AAAA',
            'aGVsbG8=',
            'aGVsbG8gd29ybGQ=',
            'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
        ];
        for (const s of samples) {
            const e = encodeBase64ToEmoji(s);
            expect(decodeEmojiToBase64(e)).toBe(s);
        }
    });

    test('в payload только символы из EMOJI_ALPHABET без base64 padding', () => {
        const e = encodeBase64ToEmoji('aGVsbG8=');
        for (const ch of Array.from(e)) {
            expect(EMOJI_ALPHABET.includes(ch)).toBe(true);
        }
        expect(e.includes(EMOJI_PAD)).toBe(false);
    });
});

test.describe('русский алфавит-кодирование', () => {
    test('Base64 → русский алфавит → Base64 обратимо', () => {
        const samples = [
            'AAAA',
            'aGVsbG8=',
            'aGVsbG8gd29ybGQ=',
            'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
        ];
        for (const s of samples) {
            const encoded = encodeBase64ToCyrillic(s);
            expect(decodeCyrillicToBase64(encoded)).toBe(s);
        }
    });
});

test.describe('новый формат 𓁗1Ⰴ𐌄Ⱑ', () => {
    test('собирается и парсится', () => {
        const k = deriveKeyMaterialFromSeed('короткий формат').k1;
        const b64 = aesGcmEncrypt('hello', k);
        const encoded = encodeBase64ToEmoji(b64);
        const msg = `${FORMAT_START}1${FORMAT_MID}${CODEC_MARKERS.emoji}${FORMAT_PAYLOAD}${encoded}`;

        const match = new RegExp(`^${FORMAT_START}(.+?)${FORMAT_MID}([${CODEC_MARKERS.base64}${CODEC_MARKERS.emoji}${CODEC_MARKERS.cyrillic}])${FORMAT_PAYLOAD}(.+)$`, 'u').exec(msg);
        expect(match).not.toBeNull();
        expect(match[1]).toBe('1');
        expect(match[2]).toBe(CODEC_MARKERS.emoji);
        expect(aesGcmDecrypt(decodeEmojiToBase64(match[3]), k)).toBe('hello');
    });
});
