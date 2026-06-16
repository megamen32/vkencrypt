"""VKEncrypt-бот: AES-256-GCM echo-сервер с двумя режимами загрузки ключей.

Получает сообщение от MY_USER_ID, расшифровывает (если формат ENC[key_id:base64])
или шифрует (если обычный текст), и отправляет результат обратно. По сути
заменяет Telegram-бота с тем же уровнем end-to-end шифрования, но средствами
ВКонтакте.

Источники ключей (в порядке загрузки, более поздние перезаписывают):
  1. PRE_SHARED_KEY_<id> в .env — прямой 64-hex ключ.
  2. SEED_PHRASE в .env — фраза, из которой PBKDF2-SHA256 деривит k1..k4.
  3. bot/keys.json — то, что юзер накопил командами /setseed, /setkey.

KDF полностью совпадает с userscript'ом расширения (PBKDF2, salt
'vk-p2p-aes-gcm-v1', 250 000 итераций, 1024 бит → 4 × 32 байта).
"""
import base64
import hashlib
import json
import os
import re
from pathlib import Path

import vk_api
from vk_api.longpoll import VkLongPoll, VkEventType
from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.environ["VK_TOKEN"]
MY_USER_ID = int(os.environ["MY_USER_ID"])
DEFAULT_KEY_ID = os.environ.get("DEFAULT_KEY_ID", "k1")

# === KDF параметры — должны 1-в-1 совпадать с extension/vkencrypt.user.js ===
KDF_SALT = "vk-p2p-aes-gcm-v1"
KDF_ITERATIONS = 250_000
KDF_DKLEN = 128  # 4 × 32 байта

# === Хранилище ключей в памяти и на диске ===
KEYS_FILE = Path(__file__).parent / "keys.json"
PRE_SHARED_KEYS: dict[str, dict] = {}


def derive_keys_from_seed(seed: str) -> dict[str, bytes]:
    """Деривация k1..k4 из seed-фразы. Должна совпадать с extension'ом байт-в-байт."""
    if not seed or len(seed.strip()) < 6:
        raise ValueError("Seed-фраза должна быть не короче 6 символов")

    derived = hashlib.pbkdf2_hmac(
        "sha256",
        seed.strip().encode("utf-8"),
        KDF_SALT.encode("utf-8"),
        KDF_ITERATIONS,
        dklen=KDF_DKLEN,
    )
    return {
        "k1": derived[0:32],
        "k2": derived[32:64],
        "k3": derived[64:96],
        "k4": derived[96:128],
    }


def _is_valid_hex_key(value: str) -> bool:
    return bool(re.match(r"^[0-9a-f]{64}$", value.strip().lower()))


def _load_persisted_keys() -> None:
    if not KEYS_FILE.exists():
        return
    try:
        data = json.loads(KEYS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"⚠️ Не удалось прочитать {KEYS_FILE}: {e}")
        return
    for key_id, key_hex in data.items():
        if _is_valid_hex_key(key_hex):
            PRE_SHARED_KEYS[key_id] = {
                "key": bytes.fromhex(key_hex),
                "active": True,
            }


def _save_persisted_keys() -> None:
    out = {k: v["key"].hex() for k, v in PRE_SHARED_KEYS.items()}
    KEYS_FILE.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        os.chmod(KEYS_FILE, 0o600)
    except OSError:
        pass


def _load_env_keys() -> None:
    """Грузим прямые hex-ключи и seed-фразу из .env."""
    for env_key, value in os.environ.items():
        if env_key.startswith("PRE_SHARED_KEY_"):
            key_id = env_key[len("PRE_SHARED_KEY_"):].lower()
            if _is_valid_hex_key(value):
                PRE_SHARED_KEYS[key_id] = {"key": bytes.fromhex(value), "active": True}
            else:
                print(f"⚠️ {env_key} не похож на 64-hex, пропускаю")

    seed = os.environ.get("SEED_PHRASE", "").strip()
    if seed:
        try:
            for key_id, key_bytes in derive_keys_from_seed(seed).items():
                PRE_SHARED_KEYS[key_id] = {"key": key_bytes, "active": True}
        except ValueError as e:
            print(f"⚠️ SEED_PHRASE в .env невалиден: {e}")


# === Шифрование / расшифровка ===
def encrypt_message(plain_text: str, key_id: str) -> str:
    if key_id not in PRE_SHARED_KEYS:
        raise ValueError(f"Неизвестный key_id: {key_id}")

    key = PRE_SHARED_KEYS[key_id]["key"]
    iv = get_random_bytes(12)

    cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
    ciphertext, tag = cipher.encrypt_and_digest(plain_text.encode("utf-8"))

    payload = iv + ciphertext + tag
    b64_payload = base64.b64encode(payload).decode("utf-8")
    return f"ENC[{key_id}:{b64_payload}]"


def decrypt_message(encrypted_text: str) -> tuple[str, str] | None:
    """Расшифровывает сообщение формата ENC[key_id:b64payload].
    Возвращает (plain_text, key_id) или None, если не получилось.
    """
    if not encrypted_text.startswith("ENC[") or not encrypted_text.endswith("]"):
        return None

    try:
        content = encrypted_text[4:-1]
        key_id, b64_payload = content.split(":", 1)

        if key_id not in PRE_SHARED_KEYS:
            return None

        payload = base64.b64decode(b64_payload)
        iv = payload[:12]
        ciphertext = payload[12:-16]
        tag = payload[-16:]

        key = PRE_SHARED_KEYS[key_id]["key"]
        cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
        plain_text = cipher.decrypt_and_verify(ciphertext, tag).decode("utf-8")

        return plain_text, key_id
    except Exception:
        return None


# === Команды ===
HELP_TEXT = (
    "🔐 VKEncrypt-бот\n"
    "\n"
    "Команды:\n"
    "  /setseed <фраза>  — установить seed, сгенерятся k1..k4\n"
    "  /delseed          — удалить k1..k4\n"
    "  /setkey <id> <64-hex>  — добавить пользовательский ключ\n"
    "  /delkey <id>      — удалить ключ\n"
    "  /keys             — список активных ключей\n"
    "  /help             — эта справка\n"
    "\n"
    "Любое другое сообщение: если формат ENC[id:...] — расшифрую и\n"
    "пришлю обратно зашифрованным; иначе — просто зашифрую и пришлю."
)


def _handle_setseed(arg: str) -> str:
    try:
        derived = derive_keys_from_seed(arg)
    except ValueError as e:
        return f"❌ {e}"
    for key_id, key_bytes in derived.items():
        PRE_SHARED_KEYS[key_id] = {"key": key_bytes, "active": True}
    _save_persisted_keys()
    return "✅ Seed принят, ключи k1..k4 сгенерированы и сохранены"


def _handle_delseed() -> str:
    removed = []
    for key_id in ("k1", "k2", "k3", "k4"):
        if PRE_SHARED_KEYS.pop(key_id, None) is not None:
            removed.append(key_id)
    _save_persisted_keys()
    if removed:
        return f"✅ Удалены: {', '.join(removed)}"
    return "ℹ️ Дерив-ключей и так не было"


def _handle_setkey(arg: str) -> str:
    parts = arg.split(maxsplit=1)
    if len(parts) != 2:
        return "❌ Формат: /setkey <имя> <64-hex>"
    key_id, key_hex = parts[0].strip().lower(), parts[1].strip().lower()

    if not re.match(r"^[a-z0-9_.@-]{1,32}$", key_id):
        return "❌ Имя: буквы/цифры/_/-/. /@, до 32 символов"
    if key_id in ("k1", "k2", "k3", "k4", "@temp"):
        return "❌ Это имя зарезервировано (используй /setseed для k1..k4)"
    if not _is_valid_hex_key(key_hex):
        return "❌ Ключ должен быть ровно 64 hex-символа"

    PRE_SHARED_KEYS[key_id] = {"key": bytes.fromhex(key_hex), "active": True}
    _save_persisted_keys()
    return f"✅ Ключ {key_id} сохранён"


def _handle_delkey(arg: str) -> str:
    key_id = arg.strip().lower()
    if not key_id:
        return "❌ Укажи имя ключа: /delkey <id>"
    if key_id in ("k1", "k2", "k3", "k4"):
        return "❌ k1..k4 удаляются через /delseed"
    if PRE_SHARED_KEYS.pop(key_id, None) is None:
        return f"❌ Ключ {key_id} не найден"
    _save_persisted_keys()
    return f"✅ Ключ {key_id} удалён"


def _handle_keys() -> str:
    active = sorted(k for k, v in PRE_SHARED_KEYS.items() if v["active"])
    if not active:
        return (
            "ℹ️ Ключей нет.\n"
            "  /setseed <фраза>  или  /setkey <id> <64-hex>"
        )
    return f"Активные ключи: {', '.join(active)}"


def handle_command(msg_text: str) -> str | None:
    """Возвращает текст ответа, или None если это не команда."""
    if not msg_text.startswith("/"):
        return None
    parts = msg_text.split(maxsplit=1)
    cmd = parts[0].lower()
    arg = parts[1] if len(parts) > 1 else ""

    if cmd in ("/help", "/start"):
        return HELP_TEXT
    if cmd == "/keys":
        return _handle_keys()
    if cmd == "/setseed":
        if not arg:
            return "❌ Формат: /setseed <фраза>"
        return _handle_setseed(arg)
    if cmd == "/delseed":
        return _handle_delseed()
    if cmd == "/setkey":
        return _handle_setkey(arg)
    if cmd == "/delkey":
        return _handle_delkey(arg)
    return f"❓ Неизвестная команда: {cmd}\n\n{HELP_TEXT}"


# === Главный цикл ===
def start_bot() -> None:
    _load_env_keys()
    _load_persisted_keys()

    vk_session = vk_api.VkApi(token=TOKEN)
    vk = vk_session.get_api()
    longpoll = VkLongPoll(vk_session)

    active = sorted(PRE_SHARED_KEYS.keys())
    print(f"Бот запущен. Активные ключи: {active or '(нет)'}")
    if not active:
        print(
            "💡 Чтобы добавить ключи, отправь боту /setseed <фраза> "
            "или /setkey <id> <64-hex>."
        )

    for event in longpoll.listen():
        if event.type != VkEventType.MESSAGE_NEW or not event.to_me:
            continue

        user_id = event.user_id
        if user_id != MY_USER_ID:
            continue

        msg_text = event.text or ""

        # 1. Команды
        reply = handle_command(msg_text)
        if reply is not None:
            vk.messages.send(user_id=user_id, message=reply, random_id=0)
            continue

        # 2. Нет ключей вообще — подсказка
        if not PRE_SHARED_KEYS:
            vk.messages.send(
                user_id=user_id,
                message=(
                    "❌ Нет ни одного ключа — зашифровать нечем.\n"
                    "Сначала /setseed <фраза> или /setkey <id> <64-hex>."
                ),
                random_id=0,
            )
            continue

        # 3. Шифрование/расшифровка
        try:
            decrypted = decrypt_message(msg_text)
            if decrypted:
                plain_text, _ = decrypted
                encrypted = encrypt_message(plain_text, DEFAULT_KEY_ID)
            else:
                encrypted = encrypt_message(msg_text, DEFAULT_KEY_ID)
            vk.messages.send(user_id=user_id, message=encrypted, random_id=0)
        except Exception as e:
            vk.messages.send(
                user_id=user_id,
                message=f"Ошибка: {e}",
                random_id=0,
            )


if __name__ == "__main__":
    start_bot()
