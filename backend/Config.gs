/* ============================================================
   ФЕРМА — общий бэкенд (Apps Script). Файл настроек.

   Секретов в коде нет — значения лежат в Script Properties
   (Project Settings → Script properties). Задать разово:
   открыть setConfig(), вписать значения, Run, тело можно очистить.

   Ключи:
   FARM_SHEET_ID            — id таблицы «Ферма» (бывшая «Самосбор-2026»)
   BOT_TOKEN                — токен Telegram-бота (уведомления, проверка initData)
   NOTIFY_IDS               — кому слать (инструмент-напоминания + новые заявки
                              самосбора); через запятую/пробел
   SAMOSBOR_ADMIN_PASSWORD  — пароль для samosbor_admin.html; пусто = проверка
                              выключена (доступ уже ограничен тегом в LEADTEX)
   SAMOSBOR_SITE_URL        — ссылка на форму записи (для писем «место освободилось»)
   REMIND_REPEAT_DAYS       — повтор напоминания по одной выдаче, дней (3)
   REMIND_BEFORE_DAYS       — напоминать за N дней до срока (0)
   REQUIRE_TG_AUTH          — '1' → требовать подписанный Telegram initData
   TZ                       — часовой пояс (Europe/Minsk)
   ============================================================ */

var CFG = {
  get farmSheetId(){ return prop_('FARM_SHEET_ID', ''); },
  get botToken(){ return prop_('BOT_TOKEN', ''); },
  get notifyIds(){ return prop_('NOTIFY_IDS', '').split(/[,\s]+/).filter(String); },
  get adminPassword(){ return prop_('SAMOSBOR_ADMIN_PASSWORD', ''); },
  get siteUrl(){ return prop_('SAMOSBOR_SITE_URL', ''); },
  get remindRepeatDays(){ return Math.max(1, Number(prop_('REMIND_REPEAT_DAYS', '3')) || 3); },
  get remindBeforeDays(){ return Number(prop_('REMIND_BEFORE_DAYS', '0')) || 0; },
  get requireTgAuth(){ return prop_('REQUIRE_TG_AUTH', '0') === '1'; },
  get tz(){ return prop_('TZ', '') || Session.getScriptTimeZone() || 'Europe/Minsk'; }
};

function prop_(k, d){
  var v = PropertiesService.getScriptProperties().getProperty(k);
  return (v == null || v === '') ? d : v;
}

/** Запусти один раз: впиши значения → Run. Потом можно вернуть заглушки. */
function setConfig(){
  PropertiesService.getScriptProperties().setProperties({
    FARM_SHEET_ID:           '1WoJR_oLEfTIAGc5rmZ3KW3TrNYH7p3kgzibXMuHAqQw',
    BOT_TOKEN:               'PASTE_BOT_TOKEN',        // перевыпусти старый у @BotFather — он светился в git
    NOTIFY_IDS:              '6204739474',
    SAMOSBOR_ADMIN_PASSWORD: 'PASTE_ADMIN_PASSWORD',   // пусто = выключить проверку (доступ уже через LEADTEX)
    SAMOSBOR_SITE_URL:       'https://birsiti.github.io/zveroferma-dot/samosbor_registraciya_web.html',
    REMIND_REPEAT_DAYS:      '3',
    REMIND_BEFORE_DAYS:      '0',
    REQUIRE_TG_AUTH:         '0',
    TZ:                      'Europe/Minsk'
  }, true);
}
