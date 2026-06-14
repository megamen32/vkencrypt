"""VKEncrypt-бот: echo-сервер с AES-256-GCM шифрованием.

Получает сообщение от MY_USER_ID, расшифровывает (если формат ENC[key_id:base64])
или шифрует (если обычный текст), и отправляет результат обратно. По сути
заменяет Telegram-бота с тем же уровнем end-to-end шифрования, но средствами
ВКонтакте.

Ключи загружаются из переменных окружения вида PRE_SHARED_KEY_<ID>.
"""
import os
import base64
import vk_api
from vk_api.longpoll import VkLongPoll, VkEventType
from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.environ["VK_TOKEN"]
MY_USER_ID = int(os.environ["MY_USER_ID"])
DEFAULT_KEY_ID = os.environ.get("DEFAULT_KEY_ID", "k1")

PRE_SHARED_KEYS: dict[str, dict] = {}
for key, value in os.environ.items():
    if key.startswith("PRE_SHARED_KEY_"):
        key_id = key[len("PRE_SHARED_KEY_"):].lower()
        PRE_SHARED_KEYS[key_id] = {"key": bytes.fromhex(value), "active": True}


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


def start_bot() -> None:
    if not PRE_SHARED_KEYS:
        raise RuntimeError("Не задан ни один ключ PRE_SHARED_KEY_*")

    vk_session = vk_api.VkApi(token=TOKEN)
    vk = vk_session.get_api()
    longpoll = VkLongPoll(vk_session)

    print(f"Бот запущен. Активные ключи: {[k for k, v in PRE_SHARED_KEYS.items() if v['active']]}")

    for event in longpoll.listen():
        if event.type != VkEventType.MESSAGE_NEW or not event.to_me:
            continue

        msg_text = event.text
        user_id = event.user_id
        if user_id != MY_USER_ID:
            continue

        if msg_text.startswith("/"):
            if msg_text.lower() == "/keys":
                active = [k for k, v in PRE_SHARED_KEYS.items() if v["active"]]
                vk.messages.send(
                    user_id=user_id,
                    message=f"Активные ключи: {', '.join(active)}",
                    random_id=0,
                )
            continue

        decrypted = decrypt_message(msg_text)
        try:
            if decrypted:
                plain_text, _ = decrypted
                encrypted = encrypt_message(plain_text, DEFAULT_KEY_ID)
            else:
                encrypted = encrypt_message(msg_text, DEFAULT_KEY_ID)
            vk.messages.send(user_id=user_id, message=encrypted, random_id=0)
        except Exception as e:
            vk.messages.send(user_id=user_id, message=f"Ошибка: {e}", random_id=0)


if __name__ == "__main__":
    start_bot()
