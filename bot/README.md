# Бот VKEncrypt (Python)

Серверная часть VKEncrypt — VK-бот, который работает как **echo-шифратор** с AES-256-GCM:

- Получает сообщение от `MY_USER_ID`.
- Если сообщение в формате `ENC[key_id:base64...]` — расшифровывает, потом шифрует обратно и отправляет.
- Если сообщение обычное — шифрует и отправляет зашифрованный результат.

Бот — это «транспорт» для проверки: показывает, что ваше расширение правильно шифрует, и подтверждает, что сервер может расшифровать. End-to-end шифрование по-прежнему держится на ключах из `bot/.env`, которыми бот и расширение делятся через `../extension/build.sh`.

## Структура

```text
bot/
├── main.py                      # Бот: long-poll, шифрование/расшифровка
├── gen_key.py                   # Генератор одного 256-битного ключа (hex)
├── pyproject.toml               # Зависимости (pycryptodome, vk-api, python-dotenv)
├── uv.lock                      # Зафиксированные версии (uv)
├── .python-version              # Python >= 3.13
├── .env.example                 # Шаблон .env
├── vkencrypt.service.template   # Шаблон systemd-юнита
├── deploy.sh                    # Установка + systemd + (опционально) сборка userscript
└── README.md
```

## Установка и запуск

```bash
cd bot
sudo ./deploy.sh
```

Скрипт автоматически:

1. Создаст `.venv` (через `uv` или `python3 -m venv`).
2. Установит зависимости.
3. Сгенерирует `.env` с двумя случайными ключами K1, K2.
4. Зарендерит `vkencrypt.service` из шаблона и положит в `/etc/systemd/system/`.
5. Запустит бота через systemd.
6. Соберёт актуальный userscript в `../extension/dist/` (если extension существует).

После `deploy.sh` откройте `.env` и впишите свои `VK_TOKEN` и `MY_USER_ID`:

```bash
sudo systemctl stop vkencrypt
nano .env
sudo systemctl start vkencrypt
```

## Получение VK_TOKEN

1. Создайте сообщество ВКонтакте (или используйте существующее).
2. Управление → Дополнительно → Работа с API → Ключи доступа → Создать ключ.
3. Включите **Long Poll API** в настройках сообщества (Типы событий → Сообщения).

## Получение MY_USER_ID

Откройте [id.vk.com/account](https://id.vk.com/account/#/personal) — там указан ваш числовой ID.

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `VK_TOKEN` | Токен сообщества ВКонтакте |
| `MY_USER_ID` | Ваш числовой ID ВКонтакте (фильтр — бот отвечает только ему) |
| `PRE_SHARED_KEY_K1` | 32-байтный ключ в hex (64 символа) |
| `PRE_SHARED_KEY_K2` | Запасной ключ |
| `DEFAULT_KEY_ID` | Слот по умолчанию (`k1`) |

`.env` содержит секреты — **не коммитьте его**.

## Управление сервисом

```bash
sudo systemctl status vkencrypt         # статус
sudo systemctl restart vkencrypt        # перезапуск (после правки .env)
sudo systemctl stop vkencrypt           # остановить
sudo journalctl -u vkencrypt -f         # логи в реальном времени
```

Удаление:

```bash
sudo systemctl disable vkencrypt
sudo rm /etc/systemd/system/vkencrypt.service
sudo systemctl daemon-reload
```

## Генерация нового ключа

```bash
python3 gen_key.py
# -> <64 hex-символа>
```

Скопируйте вывод в `.env` как `PRE_SHARED_KEY_K3=<значение>` и перезапустите сервис. После этого пересоберите userscript в `extension/`, чтобы расширение знало про новый ключ.

## Криптография

- **Алгоритм:** AES-256-GCM
- **Ключ:** 256 бит (32 байта), хранится в `.env`
- **IV/Nonce:** 12 байт, новый для каждого сообщения
- **Tag:** 16 байт, проверяется автоматически
- **Формат:** `ENC[key_id:base64( iv ‖ ciphertext ‖ tag )]`

Ключи никогда не передаются в сообщениях — только зашифрованный текст.
