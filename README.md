# VKEncrypt

Шифрует сообщения в ВКонтакте. Установка — 5 секунд.

<img src="docs/media/IMG_9299_part1.webp" width="280" alt="VKEncrypt (iPhone) в действии">&nbsp;&nbsp;<img src="docs/media/IMG_9299_part2.webp" width="280" alt="VKEncrypt (Android) расшифровка">

## Установка

### iPhone (Safari)

1. Поставь [Userscripts](https://apps.apple.com/app/userscripts/id1463296397) из App Store.
2. Нажми **[сюда](https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js)** — откроется в Safari.
3. Нажми кнопку «Поделиться» (квадрат со стрелкой) → **Userscripts** → **Import**.
4. Зайди в `vk.com` и открой любой чат.

### Компьютер или Android

1. Поставь [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) в свой браузер (Chrome / Firefox / Edge / Brave / Kiwi на Android).
2. Нажми **[Установить VKEncrypt](https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js)** — Tampermonkey сам откроет окно установки. Жми «Установить».
3. Зайди в `vk.com` и открой любой чат.

## Как пользоваться

При первом открытии чата в поле ввода появятся две иконки:

- **🔒** — зашифровать набранное сообщение. Если ключей ещё нет — откроется окно настройки.
- **🔑** — меню ключей, настроек и seed-фразы.

Введи секретную фразу (≥ 6 символов, лучше длиннее) — скрипт детерминированно сгенерирует ключи `k1..k4` и сохранит их. Собеседник с той же фразой получит те же ключи. Можно также добавлять свои 64-hex ключи через меню.

Опционально: **автошифрование** (в меню 🔑) — тогда Enter сам шифрует и отправляет, а ручной 🔒 прячется. Shift+Enter остаётся переносом строки.

Скрипт обновляется сам — ничего делать не нужно.

## Подробности

- Как устроено шифрование, как менять ключи, формат шифра, безопасность — в [TECHNICAL.md](TECHNICAL.md).
- Установка VK-бота (опционально, для проверки ключей через echo) — в [bot/README.md](bot/README.md).
- Детали по расширению для разработчиков — в [extension/README.md](extension/README.md).

## Лицензия

[MIT](LICENSE)
