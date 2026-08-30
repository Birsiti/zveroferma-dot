/* ============================================================
   ФЕРМА · установка, миграция, триггеры, меню.

   Порядок первого запуска:
   1. Config.gs → setConfig(): впиши FARM_SHEET_ID, BOT_TOKEN, NOTIFY_IDS → Run.
   2. Setup.gs → setup(): создаёт/дополняет листы, ставит триггер напоминаний.
   3. Setup.gs → importToolData(): разово переносит инструмент из старой
      таблицы (id ниже) в лист «Инструмент». Повторный запуск ничего не делает.
   4. Deploy → New deployment → Web app (Execute as: Me, Access: Anyone).
      Полученный /exec вписать в CONFIG.apiUrl всех трёх HTML.
   ============================================================ */

var OLD_TOOL_SHEET_ID = '1-hPI4eX-WsZ0elXbPELrtmKDxDV6NCUNMz1MSQ2wVPw';
var OLD_TOOL_TAB      = 'Sheet1';

function setup(){
  // Инструмент
  sheet_(TOOL_SHEET, TOOL_COLS);
  sheet_(TOOL_LOG, TOOL_LOG_COLS);
  // Самосбор
  sheet_(SB_SET, SB_SET_COLS);
  ensureHeaders_(SB_REG, SB_REG_COLS);   // допишет «Статус», «Дата_заезда», «Приглашён»
  ensureHeaders_(SB_WAIT, SB_WAIT_COLS);
  sheet_(SB_CONTACTS, SB_CONTACTS_COLS); // лог визитов формы + автоподстановка имени/телефона
  ensureSamosborDefaults_();
  // Триггер напоминаний по инструменту (~8:00 ежедневно)
  removeTriggers_('Tool_sendReminders');
  ScriptApp.newTrigger('Tool_sendReminders').timeBased().everyDays(1).atHour(8).create();

  Logger.log('setup(): листы готовы, триггер Tool_sendReminders поставлен. ' +
             'Дальше — importToolData(), затем Deploy → Web app.');
}

/** Гарантирует, что в шапке листа есть все нужные заголовки (недостающие дописываются справа). */
function ensureHeaders_(name, headers){
  var sh = sheet_(name, headers);
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), headers.length)).getValues()[0]
    .map(function(h){ return String(h).trim(); });
  headers.forEach(function(h, i){
    if (head.indexOf(h) === -1){
      var col = head.length + 1;
      sh.getRange(1, col).setValue(h);
      head.push(h);
    }
  });
  sh.setFrozenRows(1);
}

function ensureSamosborDefaults_(){
  var s = Samosbor_settings_();
  var def = {
    SEASON_ACTIVE: 'TRUE', SESSION_OPEN: 'FALSE',
    SESSION_DATE: '', SESSION_TIME: '', SESSION_PRICE: '', LIMIT: '10'
  };
  Object.keys(def).forEach(function(k){
    if (s[k] === undefined) Samosbor_setSetting_(k, def[k]);
  });
}

/** Разовый перенос инструмента из старой таблицы. Идемпотентно: если в
    «Инструмент» уже есть строки — ничего не делает. */
function importToolData(){
  var dst = sheet_(TOOL_SHEET, TOOL_COLS);
  if (dst.getLastRow() > 1){
    Logger.log('importToolData(): лист «Инструмент» не пуст — пропуск.');
    return;
  }
  var src = SpreadsheetApp.openById(OLD_TOOL_SHEET_ID).getSheetByName(OLD_TOOL_TAB)
         || SpreadsheetApp.openById(OLD_TOOL_SHEET_ID).getSheets()[0];
  var values = src.getDataRange().getValues();
  var rows = values.slice(1).filter(function(r){ return r[0] !== '' && r[0] != null; });
  // старый лист: id,item,who,issued,confirm,returned,by,confirmedAt,confirmedBy,qty,returnedQty,comment
  rows.forEach(function(r){
    dst.appendRow([
      r[0], r[1], r[2], fmtDateCell_(r[3]), fmtDateCell_(r[4]),
      r[5] ? fmtDateCell_(r[5]) : '', r[6] || '',
      r[7] ? fmtDateCell_(r[7]) : '', r[8] || '',
      Number(r[9]) || 1, Number(r[10]) || 0, r[11] || ''
    ]);
  });
  Logger.log('importToolData(): перенесено строк — ' + rows.length);
}

function removeTriggers_(handler){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

/* ---------- меню в таблице ---------- */

function onOpen(){
  SpreadsheetApp.getUi().createMenu('Ферма')
    .addItem('Инструмент: напоминания сейчас', 'Tool_runRemindersNow')
    .addItem('Инструмент: переустановить триггер', 'reinstallToolTrigger')
    .addSeparator()
    .addItem('Самосбор: позвать весь пул на заезд', 'Samosbor_inviteAllPool')
    .addSeparator()
    .addItem('Создать/дополнить листы', 'setup')
    .addItem('Импорт инструмента из старой таблицы', 'importToolData')
    .addToUI();
}
function reinstallToolTrigger(){
  removeTriggers_('Tool_sendReminders');
  ScriptApp.newTrigger('Tool_sendReminders').timeBased().everyDays(1).atHour(8).create();
}

/** Вернуть кнопку меню бота к списку команд (если Menu Button в BotFather
    перекрыл команды веб-аппом). Запусти вручную один раз. */
function resetBotMenuToCommands(){
  if (!CFG.botToken){ Logger.log('BOT_TOKEN не задан'); return; }
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + CFG.botToken + '/setChatMenuButton', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ menu_button: { type: 'commands' } }), muteHttpExceptions: true
  });
  Logger.log(res.getContentText());
}

/* ---------- удаление строки инструмента (для ошибочных / тестовых записей) ---------- */

/** Удаляет строку из «Инструмент» по id + связанные строки из «Журнал». */
function deleteToolLoan(id){
  id = String(id);
  var reg = sheet_(TOOL_SHEET, TOOL_COLS);
  var rv = reg.getDataRange().getValues();
  for (var i = rv.length - 1; i >= 1; i--){
    if (String(rv[i][0]) === id){ reg.deleteRow(i + 1); break; }
  }
  var log = sheet_(TOOL_LOG, TOOL_LOG_COLS);
  var lv = log.getDataRange().getValues();
  for (var j = lv.length - 1; j >= 1; j--){
    if (String(lv[j][2]) === id) log.deleteRow(j + 1);   // колонка C = id
  }
  Logger.log('deleteToolLoan(' + id + '): готово');
}

/** Разовая уборка тестовой записи, оставленной при проверке бэкенда. Запусти → Run. */
function cleanupTestData(){
  var reg = sheet_(TOOL_SHEET, TOOL_COLS);
  var rv = reg.getDataRange().getValues();
  for (var i = rv.length - 1; i >= 1; i--){
    if (String(rv[i][1]).indexOf('ТЕСТ БЭКЕНДА') === 0) deleteToolLoan(rv[i][0]);
  }
  Logger.log('cleanupTestData(): готово');
}

/* ---------- мини-тест (запускать вручную) ---------- */

function selfTest_(){
  Logger.log('samosbor status: ' + JSON.stringify(Samosbor_status_()));
  Logger.log('samosbor regs: ' + Samosbor_regs_().getContent());
  Logger.log('tool list: ' + Tool_get({}).getContent());
}
