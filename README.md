# VKEncrypt

Шифрует сообщения в ВКонтакте. Установка — 5 секунд.

<img src="docs/media/IMG_9299_part1.webp" width="280" alt="VKEncrypt (iPhone) в действии">&nbsp;&nbsp;<img src="docs/media/IMG_9299_part2.webp" width="280" alt="VKEncrypt (Android) расшифровка">

## Установка

### Компьютер — Tampermonkey

1. Установите расширение [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) в свой браузер (Chrome / Firefox / Edge / Brave).
2. Нажмите **[Установить VKEncrypt](https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js)** — Tampermonkey сам откроет окно установки. Жмите «Установить».
3. Откройте `vk.com`, `vk.ru` или `web.vk.me` и зайдите в любой чат.

### iPhone — Safari

1. Установите бесплатное приложение [Userscripts](https://apps.apple.com/app/userscripts/id1463296397) из App Store.
2. Откройте **Настройки iOS → Safari → Расширения → Userscripts** и включите расширение. Дайте доступ к `vk.com`, `vk.ru` и `web.vk.me`.
3. Нажмите **[Установить VKEncrypt](https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js)**. Приложение Userscripts на iPhone перехватит файл `.user.js` и предложит импортировать/установить скрипт автоматически. Если перехват не сработал — откройте меню «Поделиться» (квадрат со стрелкой) → **Userscripts** → **Import**.
4. Откройте `vk.com`, `vk.ru` или `web.vk.me` в Safari и зайдите в любой чат.

### Android — Kiwi Browser

Kiwi — единственный мобильный браузер, который поддерживает полноценные Chrome-расширения.

1. Установите [Kiwi Browser](https://play.google.com/store/apps/details?id=com.kiwibrowser.browser) из Google Play.
2. Внутри Kiwi откройте Chrome Web Store и установите **Tampermonkey**.
3. Нажмите **[Установить VKEncrypt](https://raw.githubusercontent.com/megamen32/vkencrypt/master/extension/vkencrypt.user.js)** — Tampermonkey предложит установку.
4. Откройте `vk.com`, `vk.ru` или `web.vk.me` и зайдите в любой чат.

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
