/* ============================================================
   ФЕРМА · тема «Самосбор» (голубика, «Ягодное место»).

   Поведение 1:1 со старым бэкендом самосбора (Code.gs v2.2), плюс:
   - запись идёт под общим LockService из роутера (без гонок мест);
   - отмена не удаляет строку, а ставит Статус=«отменено» (история видна);
   - GET ?area=samosbor&action=regs — список для админ-страницы.

   Листы таблицы «Ферма»:
     РЕГИСТРАЦИИ   — ID | Дата_регистрации | Имя | Телефон | Telegram_ID | Человек | Статус
     НАСТРОЙКИ     — Ключ | Значение  (SEASON_ACTIVE, SESSION_OPEN,
                     SESSION_DATE, SESSION_TIME, SESSION_PRICE, LIMIT)
     ЛИСТ_ОЖИДАНИЯ — ID | Дата_записи | Имя | Телефон | Telegram_ID | Человек | Статус

   Вместимость считается ПО ЧИСЛУ ЗАЯВОК (активных строк), не по «человек» —
   как в старом бэкенде. Одна семья = одна заявка = одно место.

   Клиенты (area=samosbor):
     GET  (bare)  → { seasonActive, open, date, time, price, count, limit, remaining, full }
     GET  ?action=regs → { ok, limit, taken, count, remaining, regs:[…], waitlist:[…] }
     POST { action:'register', name, phone, telegramId, people }
     POST { action:'waitlist', name, phone, telegramId, people }
     POST { action:'cancel', phone }
     POST { action:'regUpdate', id, status }        // админ: «пришёл» / «отменено»
     POST { action:'adminUpdate', password, seasonActive, sessionOpen, date, time, price, limit }
   ============================================================ */

var SB_REG  = 'РЕГИСТРАЦИИ';
var SB_SET  = 'НАСТРОЙКИ';
var SB_WAIT = 'ЛИСТ_ОЖИДАНИЯ';
var SB_REG_COLS  = ['ID','Дата_регистрации','Имя','Телефон','Telegram_ID','Человек','Статус'];
var SB_SET_COLS  = ['Ключ','Значение'];
var SB_WAIT_COLS = ['ID','Дата_записи','Имя','Телефон','Telegram_ID','Человек','Статус'];

/* ==================== GET ==================== */

function Samosbor_get(p){
  if (p.action === 'regs') return Samosbor_regs_();
  return json_(Samosbor_status_());
}

function Samosbor_settings_(){
  var m = {};
  readObjects_(SB_SET, SB_SET_COLS).forEach(function(r){
    var k = trim_(r['Ключ']);
    if (k) m[k] = r['Значение'];
  });
  return {
    seasonActive: String(m.SEASON_ACTIVE).toLowerCase() === 'true',
    sessionOpen:  String(m.SESSION_OPEN).toLowerCase() === 'true',
    date:  m.SESSION_DATE || '',
    time:  m.SESSION_TIME || '',
    price: m.SESSION_PRICE || '',
    limit: Number(m.LIMIT) || 10
  };
}

/** Число активных (не отменённых) заявок. */
function Samosbor_activeCount_(regs){
  regs = regs || readObjects_(SB_REG, SB_REG_COLS);
  return regs.reduce(function(a, r){
    if (!trim_(r.ID)) return a;
    return a + (Samosbor_isCancelled_(r['Статус']) ? 0 : 1);
  }, 0);
}

function Samosbor_status_(){
  var s = Samosbor_settings_();
  var count = Samosbor_activeCount_();
  var remaining = Math.max(s.limit - count, 0);
  return {
    seasonActive: s.seasonActive,
    open: s.sessionOpen,
    date: s.date, time: s.time, price: s.price,
    count: count,
    limit: s.limit,
    remaining: remaining,
    full: (!s.seasonActive || !s.sessionOpen) ? true : remaining === 0
  };
}

function Samosbor_regs_(){
  var s = Samosbor_settings_();
  var regsRaw = readObjects_(SB_REG, SB_REG_COLS).filter(function(r){ return trim_(r.ID); });
  var regs = regsRaw.map(Samosbor_regRow_);
  var wait = readObjects_(SB_WAIT, SB_WAIT_COLS).filter(function(r){ return trim_(r.ID); }).map(Samosbor_waitRow_);
  var count = Samosbor_activeCount_(regsRaw);
  return json_({
    ok: true,
    limit: s.limit,
    taken: count, count: count,
    remaining: Math.max(0, s.limit - count),
    regs: regs, waitlist: wait
  });
}
function Samosbor_regRow_(r){
  var st = trim_(r['Статус']);
  return {
    id: r.ID, ts: fmtCellTs_(r['Дата_регистрации']), name: r['Имя'],
    phone: r['Телефон'], telegramId: r['Telegram_ID'],
    people: Number(r['Человек']) || 1, status: st || 'active',
    active: !Samosbor_isCancelled_(st)
  };
}
function Samosbor_waitRow_(r){
  return {
    id: r.ID, ts: fmtCellTs_(r['Дата_записи']), name: r['Имя'],
    phone: r['Телефон'], telegramId: r['Telegram_ID'],
    people: Number(r['Человек']) || 1, status: trim_(r['Статус']) || 'ожидает'
  };
}

/* ==================== POST ==================== */

function Samosbor_post(body){
  switch (body.action){
    case 'register':    return Samosbor_register_(body);
    case 'waitlist':    return Samosbor_waitlist_(body);
    case 'cancel':      return Samosbor_cancel_(body);
    case 'regUpdate':   return Samosbor_regUpdate_(body);
    case 'adminUpdate': return Samosbor_adminUpdate_(body);
    default:            return json_({ success:false, message:'Неизвестное действие' });
  }
}

function Samosbor_register_(body){
  var s = Samosbor_settings_();
  if (!s.seasonActive || !s.sessionOpen){
    return json_({ success:false, message:'Сейчас нет открытой записи — оставьте заявку в форме' });
  }

  var name = trim_(body.name);
  var phone = trim_(body.phone);
  var people = Math.floor(Number(body.people)) || 1;
  var norm = digits_(phone);

  var st = Samosbor_status_();
  if (st.full) return json_({ success:false, full:true, message:'Мест больше нет' });

  var regs = readObjects_(SB_REG, SB_REG_COLS);
  var dup = regs.some(function(r){ return digits_(r['Телефон']) === norm && norm && !Samosbor_isCancelled_(r['Статус']); });
  if (dup) return json_({ success:false, duplicate:true, message:'Этот номер уже зарегистрирован. Если это ошибка — напишите нам' });

  var id = 'REG-' + Utilities.formatDate(new Date(), CFG.tz, 'yyMMdd-HHmmss');
  appendRow_(SB_REG, SB_REG_COLS, {
    'ID': id, 'Дата_регистрации': new Date(), 'Имя': name, 'Телефон': phone,
    'Telegram_ID': trim_(body.telegramId), 'Человек': people, 'Статус': 'active'
  });

  var ns = Samosbor_status_();
  notifyAdmins_(
    '🫐 Новая запись на самосбор!\n' +
    'Имя: ' + (name || '—') + '\n' +
    'Телефон: ' + (phone || '—') + '\n' +
    'Telegram ID: ' + (trim_(body.telegramId) || '—') + '\n' +
    'Человек: ' + people + '\n' +
    'Осталось мест: ' + ns.remaining + ' из ' + ns.limit
  );
  return json_({ success:true, id:id, remaining:ns.remaining, full:ns.full });
}

function Samosbor_cancel_(body){
  var norm = digits_(trim_(body.phone));
  if (!norm) return json_({ success:false, message:'Не указан телефон' });

  var sh = sheet_(SB_REG, SB_REG_COLS);
  var values = sh.getDataRange().getValues();
  var pCol = SB_REG_COLS.indexOf('Телефон');
  var sCol = SB_REG_COLS.indexOf('Статус');
  for (var i = 1; i < values.length; i++){
    if (digits_(values[i][pCol]) === norm && !Samosbor_isCancelled_(values[i][sCol])){
      sh.getRange(i + 1, sCol + 1).setValue('отменено');
      var ns = Samosbor_status_();
      notifyAdmins_(
        '❌ Отменена запись на самосбор\n' +
        'Телефон: ' + (trim_(body.phone) || '—') + '\n' +
        'Осталось мест: ' + ns.remaining + ' из ' + ns.limit
      );
      Samosbor_notifyNextWaitlist_(ns.remaining);
      return json_({ success:true, remaining:ns.remaining, full:ns.full });
    }
  }
  return json_({ success:false, message:'Запись с таким номером не найдена' });
}

function Samosbor_waitlist_(body){
  var s = Samosbor_settings_();
  var name = trim_(body.name);
  var phone = trim_(body.phone);
  var people = Math.floor(Number(body.people)) || 1;
  var norm = digits_(phone);
  var sessionActuallyOpen = s.seasonActive && s.sessionOpen;

  if (sessionActuallyOpen && norm){
    var regs = readObjects_(SB_REG, SB_REG_COLS);
    if (regs.some(function(r){ return digits_(r['Телефон']) === norm && !Samosbor_isCancelled_(r['Статус']); })){
      return json_({ success:false, duplicate:true, message:'Вы уже записаны на самосбор. Если планы изменились — можно отменить запись.' });
    }
  }
  if (norm){
    var wl = readObjects_(SB_WAIT, SB_WAIT_COLS);
    if (wl.some(function(r){ return digits_(r['Телефон']) === norm; })){
      return json_({ success:false, message:'Вы уже в листе ожидания' });
    }
  }

  var id = 'WL-' + Utilities.formatDate(new Date(), CFG.tz, 'yyMMdd-HHmmss');
  appendRow_(SB_WAIT, SB_WAIT_COLS, {
    'ID': id, 'Дата_записи': new Date(), 'Имя': name, 'Телефон': phone,
    'Telegram_ID': trim_(body.telegramId), 'Человек': people, 'Статус': 'ожидает'
  });

  var reason = !s.seasonActive ? '(сезон завершён — интерес на следующий год)'
             : !s.sessionOpen  ? '(между заездами — ждёт следующий набор)'
             : '(мест сейчас нет)';
  notifyAdmins_(
    '📋 Новая заявка в лист ожидания\n' +
    'Имя: ' + (name || '—') + '\n' +
    'Телефон: ' + (phone || '—') + '\n' +
    'Человек: ' + people + '\n' + reason
  );
  return json_({ success:true, id:id });
}

function Samosbor_regUpdate_(body){
  var id = trim_(body.id);
  var status = trim_(body.status) || 'active';
  var sh = sheet_(SB_REG, SB_REG_COLS);
  var values = sh.getDataRange().getValues();
  var sCol = SB_REG_COLS.indexOf('Статус') + 1;
  for (var i = 1; i < values.length; i++){
    if (String(values[i][0]) === id){ sh.getRange(i + 1, sCol).setValue(status); return json_({ ok:true }); }
  }
  return json_({ ok:false, error:'запись не найдена', code:'NOT_FOUND' });
}

function Samosbor_adminUpdate_(body){
  if (CFG.adminPassword && trim_(body.password) !== CFG.adminPassword){
    return json_({ success:false, message:'Неверный пароль' });
  }
  Samosbor_setSetting_('SEASON_ACTIVE', body.seasonActive ? 'true' : 'false');
  Samosbor_setSetting_('SESSION_OPEN',  body.sessionOpen  ? 'true' : 'false');
  Samosbor_setSetting_('SESSION_DATE',  trim_(body.date));
  Samosbor_setSetting_('SESSION_TIME',  trim_(body.time));
  Samosbor_setSetting_('SESSION_PRICE', trim_(body.price));
  Samosbor_setSetting_('LIMIT',         Math.max(1, Math.floor(Number(body.limit)) || 10));
  return json_({ success:true });
}

function Samosbor_setSetting_(key, value){
  var sh = sheet_(SB_SET, SB_SET_COLS);
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++){
    if (trim_(values[i][0]) === key){ sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

/* ==================== Лист ожидания: уведомления ==================== */

/** После освобождения места — уведомить первого в очереди (статус «ожидает»). */
function Samosbor_notifyNextWaitlist_(remaining){
  if (remaining <= 0) return;
  try {
    var sh = sheet_(SB_WAIT, SB_WAIT_COLS);
    var values = sh.getDataRange().getValues();
    var iName = SB_WAIT_COLS.indexOf('Имя');
    var iPhone = SB_WAIT_COLS.indexOf('Телефон');
    var iTg = SB_WAIT_COLS.indexOf('Telegram_ID');
    var iSt = SB_WAIT_COLS.indexOf('Статус');
    for (var i = 1; i < values.length; i++){
      var st = String(values[i][iSt] || '').trim();
      if (st === 'ожидает' || !st){
        var tgId = values[i][iTg];
        if (tgId) tgSend_(tgId, '🫐 Место освободилось! Успевайте записаться:\n' + CFG.siteUrl);
        sh.getRange(i + 1, iSt + 1).setValue('уведомлён');
        notifyAdmins_(
          '🔔 Место освободилось — уведомили следующего в листе ожидания\n' +
          'Имя: ' + (values[i][iName] || '—') + '\n' +
          'Телефон: ' + (values[i][iPhone] || '—') + '\n' +
          (tgId ? 'Уведомили автоматически в Telegram' : 'Telegram ID нет — можно позвонить')
        );
        return;
      }
    }
  } catch (err) {
    notifyAdmins_('⚠️ Не удалось уведомить лист ожидания: ' + err.message);
  }
}

/** Меню «Ферма» → «Самосбор: позвать весь лист ожидания» (новый набор). */
function Samosbor_notifyAllWaitlist(){
  var ui = SpreadsheetApp.getUi();
  var sh = sheet_(SB_WAIT, SB_WAIT_COLS);
  var values = sh.getDataRange().getValues();
  if (values.length < 2){ ui.alert('Лист ожидания пуст'); return; }
  var iTg = SB_WAIT_COLS.indexOf('Telegram_ID');
  var notified = 0;
  for (var i = 1; i < values.length; i++){
    if (values[i][iTg]){
      tgSend_(values[i][iTg], '🫐 Открыли новый набор на самосбор голубики! Вы в списке ожидания — успевайте записаться первыми:\n' + CFG.siteUrl);
      notified++;
    }
  }
  ui.alert('Уведомили ' + notified + ' из ' + (values.length - 1) + ' в листе ожидания.\n' +
           ((values.length - 1) - notified) + ' без Telegram ID — им можно позвонить по списку в таблице.');
}

/* ==================== вспомогательное ==================== */

function Samosbor_isCancelled_(s){
  var v = String(s == null ? '' : s).trim().toLowerCase();
  return v === 'отменено' || v === 'отменена' || v === 'cancelled' || v === 'canceled';
}
function fmtCellTs_(v){
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, CFG.tz, 'dd.MM.yyyy HH:mm:ss');
  return String(v == null ? '' : v).trim();
}
