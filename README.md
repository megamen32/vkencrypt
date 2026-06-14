# VKEncrypt

> Способ уйти из Telegram, но не сдаваться даже во время белых списков.

VKEncrypt — end-to-end шифрование переписки ВКонтакте через AES-256-GCM. Состоит из двух частей:

- **`extension/`** — userscript для браузера (Tampermonkey / Userscripts / Kiwi).
- **`bot/`** — VK-бот на Python, работает как echo-шифратор для проверки ключей.

Ключи никогда не передаются ВКонтакте — только шифр вида `ENC[k1:base64(iv ‖ ciphertext ‖ tag)]`.

```text
vkencrypt/
├── extension/
│   ├── vkencrypt.template.js   # Шаблон userscript (v3.3, P2P + temp key)
│   ├── build.sh                # Сборка + подстановка ключей из bot/.env
│   ├── clean.sh
│   └── README.md
├── bot/
│   ├── main.py                 # VK long-poll бот
│   ├── gen_key.py              # Генератор 256-битного ключа
│   ├── pyproject.toml
│   ├── uv.lock
│   ├── .env.example
│   ├── vkencrypt.service.template
│   ├── deploy.sh
│   └── README.md
└── README.md                   # Этот файл
```

## Быстрый старт

### 1. Запустить бота

```bash
cd bot
sudo ./deploy.sh
nano .env       # вписать VK_TOKEN и MY_USER_ID
sudo systemctl restart vkencrypt
```

### 2. Собрать и установить расширение

```bash
cd ../extension
./build.sh
# Готово: dist/vkencrypt_userscript_*.js
```

Установка в браузер — см. `extension/README.md` (есть разделы для Tampermonkey на ПК, Userscripts на iPhone, Kiwi на Android).

## Как это работает

1. Вы пишете сообщение в ВК, нажимаете 🔒 — расширение шифрует AES-256-GCM, подставляет шифр в поле ввода.
2. Сообщение уходит к боту (или к любому адресату) — в открытом виде через ВК идёт только шифр.
3. Расширение на стороне получателя видит формат `ENC[k1:...]`, находит ключ `k1` в `STATIC_KEYS` или `@temp`, расшифровывает, показывает текст с переключателем `[шифр]/[текст]`.
4. Бот VKEncrypt дополнительно проверяет ключи: принимает обычный текст → шифрует → отправляет; принимает `ENC[k1:...]` → расшифровывает → шифрует обратно → отправляет.

## Обмен ключами по P2P

Бот держит общие статические ключи (K1..K4 в `bot/.env` + `STATIC_KEYS` в userscript). Но никто не мешает обмениваться одноразовыми ключами через `@temp` (временный ключ в памяти):

1. Собеседник А нажимает 🔑 → ⚡ сгенерировать новый ключ — ключ появляется в `@temp` и копируется в буфер.
2. А передаёт ключ А→Б любым каналом вне ВК (Signal, QR-код, голосом).
3. Б нажимает 🔑 → + временный ключ → вставляет ключ → Применить.
4. Оба выбирают `@temp` и обмениваются шифрованными сообщениями. После F5 временный ключ исчезает.

## Документация

- [extension/README.md](extension/README.md) — установка userscript в Tampermonkey / Userscripts / Kiwi.
- [bot/README.md](bot/README.md) — установка, systemd, переменные окружения, криптография.

## Лицензия

MIT
