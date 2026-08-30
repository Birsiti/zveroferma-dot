# Ферма — единый бэкенд (Google Apps Script)

Один Apps Script проект + одна таблица **«Ферма»** (бывшая `Самосбор-2026`,
`1WoJR_oLEfTIAGc5rmZ3KW3TrNYH7p3kgzibXMuHAqQw`) обслуживают три клиента:

| Клиент | area | что делает |
|---|---|---|
| `instrument-lyuban.html` | `tool` | учёт выдачи/возврата инструмента |
| `samosbor_registraciya_web.html` | `samosbor` | запись клиентов на самосбор |
| `samosbor_admin.html` | `samosbor` | управление сезоном + список записавшихся |

## Файлы проекта

| Файл | Роль |
|---|---|
| `Config.gs` | настройки из Script Properties (`setConfig()`), секретов в коде нет |
| `Code.gs` | роутер `doGet`/`doPost` + общие хелперы + Telegram + проверка initData |
| `Tool.gs` | тема «Инструмент»: список, выдача, возврат, продление, напоминания |
| `Samosbor.gs` | тема «Самосбор»: статус, запись, лист ожидания, отмена, управление |
| `Setup.gs` | создание листов, миграция инструмента, триггеры, меню в таблице |

Все `.gs` делят одну глобальную область — `import` не нужен.

## Листы таблицы «Ферма»

- `Инструмент` — `id | item | who | issued | confirm | returned | by | confirmedAt | confirmedBy | qty | returnedQty | comment`
- `Журнал` — `ts | action | id | reqId | who | item | qty | by | note` (аудит + защита от дублей по `reqId`)
- `РЕГИСТРАЦИИ` — `ID | Дата_регистрации | Имя | Телефон | Telegram_ID | Человек | Статус`
- `НАСТРОЙКИ` — `Ключ | Значение` (`SEASON_ACTIVE`, `SESSION_OPEN`, `SESSION_DATE`, `SESSION_TIME`, `SESSION_PRICE`, `LIMIT`)
- `ЛИСТ_ОЖИДАНИЯ` — `ID | Дата_записи | Имя | Телефон | Telegram_ID | Человек | Статус`
- `КОНТАКТЫ` — `Telegram_ID | Username | Имя | Телефон | Первый_визит | Последний_визит | Визитов | Регистраций`
  — каждый визит формы (`POST action:'visit'`) делает upsert строки по `Telegram_ID`
  (считает визиты); имя/телефон запоминаются с последней успешной записи и при
  следующем открытии формы подставляются обратно в поля.

## Первый запуск

1. Таблицу `Самосбор-2026` переименовать в **`Ферма`** (по желанию — id не меняется).
2. В ней: **Extensions → Apps Script**. Создать 5 файлов, вставить содержимое.
3. `Config.gs` → функция **`setConfig()`**: вписать `BOT_TOKEN`, `NOTIFY_IDS`
   (`FARM_SHEET_ID` уже проставлен) → **Run**, выдать разрешения.
4. `Setup.gs` → **`setup()`** — создаст листы `Инструмент`/`Журнал`, допишет
   колонку `Статус` в `РЕГИСТРАЦИИ`, поставит ежедневный триггер напоминаний.
5. `Setup.gs` → **`importToolData()`** — разово перенесёт инструмент из старой
   таблицы `1-hPI4eX…`. Повторный запуск ничего не делает (идемпотентно).
6. **Deploy → New deployment → Web app**, *Execute as: Me*, *Who has access:
   Anyone* → скопировать URL `…/exec`.
7. Вставить этот URL в `CONFIG.apiUrl` во всех трёх HTML (сейчас там
   `PASTE_FARM_EXEC_URL`), запушить на GitHub Pages.

Обновление кода потом: **Deploy → Manage deployments → карандаш → New version → Deploy** (URL остаётся прежним).

Меню **«Ферма»** в самой таблице: напоминания по инструменту, «Самосбор: позвать
весь лист ожидания» (при открытии нового заезда), создание листов, импорт инструмента.

## Контракт API

### area=tool  (`?area=tool` либо action из списка ниже)
- `GET  ?action=list` → `{ ok, records:[…] }`
- `POST {action:'add', item, who, issued, confirm, qty, comment, by, reqId}` → `{ ok, record }`
- `POST {action:'return', id, qty, returned, reqId}` → `{ ok, result, record }`
- `POST {action:'extend', id, confirm, reqId}` → `{ ok, record }`
- `POST {action:'confirm', id, confirmedAt, confirmedBy, confirm, reqId}` → `{ ok, record }`

### area=samosbor  (bare GET, `?area=samosbor`, либо action из списка)

Модель: **пул → приглашение → подтверждение.** `РЕГИСТРАЦИИ` получают колонки
`Дата_заезда`, `Приглашён`. Статусы: `едет | без даты | приглашён | не едет | приехал | отменено`.

- `GET` (без параметров) → `{ seasonActive, open, date, time, price, count, limit, remaining, full }`
  — `count` = число подтверждённых («едет»/«приехал») на текущую дату заезда.
- `GET  ?action=reg&id=REG-…` → `{ ok, id, name, phone, people, status, tripDate, time, price, answered }`
  — данные для экрана подтверждения.
- `GET  ?action=regs` → `{ ok, sessionDate, sessionTime, limit, confirmed, pending, pool, regs:[…] }`
  — `regs` плоский список (`id, ts, name, phone, telegramId, people, status, tripDate, invitedAt`),
  админка сама раскладывает по секциям.
- `POST {action:'visit', telegramId, username}` → `{ ok, known, name, phone }` — форма зовёт при
  загрузке: пишет визит в `КОНТАКТЫ`, возвращает имя/телефон с прошлой записи для автоподстановки
  (`known:true`, если телефон известен). Без `telegramId` — пустой ответ.
- `POST {action:'register', name, phone, telegramId, username, people}` → запись на открытый заезд, `Статус`=«едет».
- `POST {action:'waitlist', name, phone, telegramId, username, people}` → в пул, `Статус`=«без даты».
- `POST {action:'cancel', phone}` → `Статус`=«отменено» (+ авто-приглашение первого из пула, если было «едет»).
- `POST {action:'confirmTrip', id, people, coming:true|false}` → из мини-аппа: `Статус`=«едет»/«не едет».
- `POST {action:'invite', id}` → админ: `Статус`=«приглашён» + бот шлёт сообщение с web_app-кнопкой.
- `POST {action:'regUpdate', id, status}` → админ: «приехал» / «без даты» (вернуть в пул).
- `POST {action:'adminUpdate', …}` → без изменений.

Кнопка в сообщении-приглашении открывает форму записи в режиме подтверждения
(`?confirm=REG-…`). URL берётся из `SAMOSBOR_SITE_URL`, при пустом — из дефолта в коде.
Меню «Ферма» → «Самосбор: позвать весь пул на заезд».

## Настройки (Script Properties)

| Ключ | Назначение |
|---|---|
| `FARM_SHEET_ID` | id таблицы «Ферма» |
| `BOT_TOKEN` | токен Telegram-бота (уведомления, initData) |
| `NOTIFY_IDS` | кому слать: напоминания по инструменту + новые заявки самосбора (через запятую) |
| `SAMOSBOR_ADMIN_PASSWORD` | пусто = проверка пароля выключена (доступ уже через LEADTEX) |
| `REMIND_REPEAT_DAYS` | повтор напоминания по одной выдаче, дней (3) |
| `REMIND_BEFORE_DAYS` | напоминать за N дней до срока (0) |
| `REQUIRE_TG_AUTH` | `1` → требовать подписанный Telegram `initData` (включать после выката клиентов) |
| `TZ` | часовой пояс (`Europe/Minsk`) |

## Безопасность

- Токен бота — только в Script Properties, не в `.gs`. Если попал в код и в
  git — перевыпустить у @BotFather (`/revoke`).
- `.gs`-файлы этого проекта в git не обязательны; если коммитить — секретов
  в них быть не должно (они в Script Properties).
