/* ============================================================
   ФЕРМА · тема «Самосбор» (голубика).

   Модель «пул → приглашение → подтверждение»:
   - человек записывается на ОТКРЫТЫЙ заезд        → Статус=«едет», Дата_заезда=дата заезда
   - или оставляет заявку без даты (запись закрыта) → Статус=«без даты»  (пул)
   - админ зовёт из пула на дату                    → Статус=«приглашён» + бот шлёт сообщение
   - человек в мини-аппе жмёт «Приеду · N» / «Не в этот раз»
        → Статус=«едет»/«не едет», Человек=N
   - на заезде админ отмечает «приехал»

   Листы таблицы «Ферма»:
     РЕГИСТРАЦИИ — ID | Дата_регистрации | Имя | Телефон | Telegram_ID | Человек
                   | Статус | Дата_заезда | Приглашён
       Статус: едет | без даты | приглашён | не едет | приехал | отменено
     НАСТРОЙКИ   — Ключ | Значение (SEASON_ACTIVE, SESSION_OPEN,
                   SESSION_DATE, SESSION_TIME, SESSION_PRICE, LIMIT)
     ЛИСТ_ОЖИДАНИЯ — старый лист; новые заявки без даты пишутся уже в РЕГИСТРАЦИИ,
                   но если в нём остались строки — админ их видит в пуле.

   Ёмкость заезда = число заявок со Статусом «едет»/«приехал» на текущую дату
   (LIMIT в НАСТРОЙКАХ). Приглашённые ещё не заняли место.

   Клиенты (area=samosbor):
     GET  (bare)               → { seasonActive, open, date, time, price, count, limit, remaining, full }
     GET  ?action=reg&id=…     → { ok, id, name, phone, people, status, tripDate, time, price, answered }
     GET  ?action=regs         → { ok, sessionDate, sessionTime, limit, confirmed, pending, pool, regs:[…] }
     POST { action:'register', name, phone, telegramId, people }
     POST { action:'waitlist', name, phone, telegramId, people }
     POST { action:'cancel', phone }
     POST { action:'confirmTrip', id, people, coming:true|false }   // из экрана подтверждения
     POST { action:'invite', id }          // админ: позвать одного из пула
     POST { action:'regUpdate', id, status }  // админ: приехал / отменено / без даты
     POST { action:'adminUpdate', seasonActive, sessionOpen, date(ISO), time(HH:MM), price(число), limit }
   ============================================================ */

var SB_REG  = 'РЕГИСТРАЦИИ';
var SB_SET  = 'НАСТРОЙКИ';
var SB_WAIT = 'ЛИСТ_ОЖИДАНИЯ';
var SB_REG_COLS  = ['ID','Дата_регистрации','Имя','Телефон','Telegram_ID','Человек','Статус','Дата_заезда','Приглашён'];
var SB_SET_COLS  = ['Ключ','Значение'];
var SB_WAIT_COLS = ['ID','Дата_записи','Имя','Телефон','Telegram_ID','Человек','Статус'];

var SB_ST = { GOING:'едет', POOL:'без даты', INVITED:'приглашён', DECLINED:'не едет', CAME:'приехал', CANCELLED:'отменено' };

/* ==================== GET ==================== */

function Samosbor_get(p){
  if (p.action === 'reg')  return Samosbor_reg_(p.id);
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
    date:  toIsoDate_(trim_(m.SESSION_DATE)),   // нормализуем к ISO даже если в листе старый формат
    time:  normTime_(trim_(m.SESSION_TIME)),
    price: String(trim_(m.SESSION_PRICE)).replace(/[^\d.,]/g, ''),
    limit: Number(m.LIMIT) || 10
  };
}

/** Все строки РЕГИСТРАЦИЙ + завалявшиеся строки старого листа ожидания как пул. */
function Samosbor_rows_(){
  var rows = readObjects_(SB_REG, SB_REG_COLS)
    .filter(function(r){ return trim_(r.ID); })
    .map(function(r){
      return {
        _row: r._row, id: trim_(r.ID), ts: fmtCellTs_(r['Дата_регистрации']),
        name: trim_(r['Имя']), phone: trim_(r['Телефон']),
        telegramId: r['Telegram_ID'] === '' ? '' : String(r['Telegram_ID']),
        people: Number(r['Человек']) || 1,
        status: trim_(r['Статус']).toLowerCase() || SB_ST.POOL,
        tripDate: trim_(r['Дата_заезда']),
        invitedAt: fmtCellTs_(r['Приглашён'])
      };
    });
  try {
    readObjects_(SB_WAIT, SB_WAIT_COLS).filter(function(r){ return trim_(r.ID); }).forEach(function(r){
      rows.push({
        _row: null, _legacyWait: true, id: trim_(r.ID), ts: fmtCellTs_(r['Дата_записи']),
        name: trim_(r['Имя']), phone: trim_(r['Телефон']),
        telegramId: r['Telegram_ID'] === '' ? '' : String(r['Telegram_ID']),
        people: Number(r['Человек']) || 1, status: SB_ST.POOL, tripDate: '', invitedAt: ''
      });
    });
  } catch(e){}
  return rows;
}

function Samosbor_isActive_(st){
  st = String(st || '').toLowerCase();
  return st !== SB_ST.CANCELLED && st !== SB_ST.DECLINED;
}

function Samosbor_status_(){
  var s = Samosbor_settings_();
  var confirmed = Samosbor_rows_().filter(function(r){
    return (r.status === SB_ST.GOING || r.status === SB_ST.CAME) && r.tripDate === s.date && s.date;
  }).length;
  var remaining = Math.max(s.limit - confirmed, 0);
  return {
    seasonActive: s.seasonActive, open: s.sessionOpen,
    date: s.date, time: s.time, price: s.price,
    count: confirmed, limit: s.limit, remaining: remaining,
    full: (!s.seasonActive || !s.sessionOpen) ? true : remaining <= 0
  };
}

/** Одна запись — для экрана подтверждения. */
function Samosbor_reg_(id){
  id = trim_(id);
  var s = Samosbor_settings_();
  var r = Samosbor_rows_().filter(function(x){ return x.id === id; })[0];
  if (!r) return json_({ ok:false, error:'not_found', message:'Запись не найдена' });
  return json_({
    ok:true, id:r.id, name:r.name, phone:r.phone, people:r.people,
    status:r.status, tripDate: r.tripDate || s.date, time: s.time, price: s.price,
    answered: (r.status === SB_ST.GOING || r.status === SB_ST.DECLINED)
  });
}

/** Список для админки. Клиент сам раскладывает по секциям. */
function Samosbor_regs_(){
  var s = Samosbor_settings_();
  var rows = Samosbor_rows_();
  var confirmed = rows.filter(function(r){ return (r.status===SB_ST.GOING||r.status===SB_ST.CAME) && r.tripDate===s.date && s.date; }).length;
  var pending  = rows.filter(function(r){ return r.status===SB_ST.INVITED && r.tripDate===s.date; }).length;
  var pool     = rows.filter(function(r){ return r.status===SB_ST.POOL; }).length;
  return json_({
    ok:true, sessionDate:s.date, sessionTime:s.time, limit:s.limit,
    confirmed:confirmed, pending:pending, pool:pool,
    regs: rows
  });
}

/* ==================== POST ==================== */

function Samosbor_post(body){
  switch (body.action){
    case 'register':    return Samosbor_register_(body);
    case 'waitlist':    return Samosbor_waitlist_(body);
    case 'cancel':      return Samosbor_cancel_(body);
    case 'confirmTrip': return Samosbor_confirmTrip_(body);
    case 'invite':      return Samosbor_invite_(body);
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
  var name = trim_(body.name), phone = trim_(body.phone);
  var people = clampInt_(body.people, 1, 10);
  var norm = digits_(phone);

  var st = Samosbor_status_();
  if (st.full) return json_({ success:false, full:true, message:'Мест больше нет' });

  var rows = Samosbor_rows_();
  if (norm && rows.some(function(r){ return digits_(r.phone) === norm && Samosbor_isActive_(r.status); })){
    return json_({ success:false, duplicate:true, message:'Этот номер уже зарегистрирован. Если это ошибка — напишите нам' });
  }

  var id = 'REG-' + Utilities.formatDate(new Date(), CFG.tz, 'yyMMdd-HHmmss');
  appendRow_(SB_REG, SB_REG_COLS, {
    'ID':id, 'Дата_регистрации':new Date(), 'Имя':name, 'Телефон':phone,
    'Telegram_ID':trim_(body.telegramId), 'Человек':people,
    'Статус':SB_ST.GOING, 'Дата_заезда':s.date, 'Приглашён':''
  });
  var ns = Samosbor_status_();
  notifyAdmins_('🫐 Записался на самосбор\n' + name + ' · ' + phone + ' · ' +
    plural_(people,'человек','человека','человек') + '\n' + fmtRuDate_(s.date) +
    ' · свободно ' + ns.remaining + '/' + ns.limit);
  return json_({ success:true, id:id, remaining:ns.remaining, full:ns.full });
}

function Samosbor_waitlist_(body){
  var name = trim_(body.name), phone = trim_(body.phone);
  var people = clampInt_(body.people, 1, 10);
  var norm = digits_(phone);
  var s = Samosbor_settings_();

  var rows = Samosbor_rows_();
  if (norm && rows.some(function(r){ return digits_(r.phone) === norm && Samosbor_isActive_(r.status); })){
    var mine = rows.filter(function(r){ return digits_(r.phone) === norm && Samosbor_isActive_(r.status); })[0];
    if (mine.status === SB_ST.GOING || mine.status === SB_ST.INVITED)
      return json_({ success:false, duplicate:true, message:'Вы уже записаны на самосбор. Если планы изменились — можно отменить запись.' });
    return json_({ success:false, message:'Вы уже в списке — сообщим, когда откроем заезд' });
  }

  var id = 'REG-' + Utilities.formatDate(new Date(), CFG.tz, 'yyMMdd-HHmmss');
  appendRow_(SB_REG, SB_REG_COLS, {
    'ID':id, 'Дата_регистрации':new Date(), 'Имя':name, 'Телефон':phone,
    'Telegram_ID':trim_(body.telegramId), 'Человек':people,
    'Статус':SB_ST.POOL, 'Дата_заезда':'', 'Приглашён':''
  });
  notifyAdmins_('📋 Заявка без даты\n' + name + ' · ' + phone + ' · ' +
    plural_(people,'человек','человека','человек'));
  return json_({ success:true, id:id });
}

function Samosbor_cancel_(body){
  var norm = digits_(trim_(body.phone));
  if (!norm) return json_({ success:false, message:'Не указан телефон' });

  var sh = sheet_(SB_REG, SB_REG_COLS);
  var values = sh.getDataRange().getValues();
  var pCol = SB_REG_COLS.indexOf('Телефон'), sCol = SB_REG_COLS.indexOf('Статус');
  for (var i = 1; i < values.length; i++){
    if (digits_(values[i][pCol]) === norm && Samosbor_isActive_(values[i][sCol])){
      var wasGoing = String(values[i][sCol]).toLowerCase() === SB_ST.GOING;
      var tripDate = trim_(values[i][SB_REG_COLS.indexOf('Дата_заезда')]);
      sh.getRange(i + 1, sCol + 1).setValue(SB_ST.CANCELLED);
      var ns = Samosbor_status_();
      notifyAdmins_('❌ Отменил запись\n' + values[i][SB_REG_COLS.indexOf('Имя')] + ' · ' + values[i][pCol] +
        '\nСвободно ' + ns.remaining + '/' + ns.limit);
      if (wasGoing) Samosbor_inviteNextFromPool_();   // место освободилось — зовём следующего
      return json_({ success:true, remaining:ns.remaining, full:ns.full });
    }
  }
  return json_({ success:false, message:'Запись с таким номером не найдена' });
}

/** Подтверждение приезда из мини-аппа. */
function Samosbor_confirmTrip_(body){
  var id = trim_(body.id);
  var s = Samosbor_settings_();
  var sh = sheet_(SB_REG, SB_REG_COLS);
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++){
    if (String(values[i][0]) === id){
      var rowNum = i + 1;
      var name = values[i][SB_REG_COLS.indexOf('Имя')];
      var tripDate = trim_(values[i][SB_REG_COLS.indexOf('Дата_заезда')]) || s.date;
      if (body.coming){
        var people = clampInt_(body.people, 1, 10);
        Samosbor_setFields_(rowNum, { 'Статус':SB_ST.GOING, 'Человек':people, 'Дата_заезда':tripDate });
        notifyAdmins_('✅ ' + name + ' приедет · ' + plural_(people,'человек','человека','человек') + '\n' + fmtRuDate_(tripDate));
        return json_({ success:true, coming:true, date:tripDate, time:s.time });
      } else {
        Samosbor_setFields_(rowNum, { 'Статус':SB_ST.DECLINED });
        notifyAdmins_('🚫 ' + name + ' не приедет · ' + fmtRuDate_(tripDate));
        return json_({ success:true, coming:false, date:tripDate });
      }
    }
  }
  return json_({ success:false, message:'Запись не найдена' });
}

/** Админ: позвать одного человека из пула на текущий заезд. */
function Samosbor_invite_(body){
  var id = trim_(body.id);
  var s = Samosbor_settings_();
  if (!s.date) return json_({ ok:false, error:'no_date', message:'Сначала задай дату заезда в настройках' });

  var sh = sheet_(SB_REG, SB_REG_COLS);
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++){
    if (String(values[i][0]) === id){
      var rowNum = i + 1;
      var tgId = values[i][SB_REG_COLS.indexOf('Telegram_ID')];
      var name = values[i][SB_REG_COLS.indexOf('Имя')];
      Samosbor_setFields_(rowNum, {
        'Статус':SB_ST.INVITED, 'Дата_заезда':s.date,
        'Приглашён':Utilities.formatDate(new Date(), CFG.tz, 'dd.MM.yyyy HH:mm')
      });
      if (!tgId){
        return json_({ ok:true, sent:false, message:'У ' + name + ' нет Telegram — позвони сам' });
      }
      var ok = Samosbor_sendInvite_(String(tgId), id, name, s);
      return json_({ ok:true, sent:ok });
    }
  }
  return json_({ ok:false, error:'not_found', message:'Запись не найдена' });
}

var SB_CONFIRM_URL_DEFAULT = 'https://birsiti.github.io/zveroferma-dot/samosbor_registraciya_web.html';

function Samosbor_sendInvite_(tgId, id, name, s){
  var base = CFG.siteUrl || SB_CONFIRM_URL_DEFAULT;
  var url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'confirm=' + encodeURIComponent(id);
  var text = '🫐 Открыли самосбор голубики' + (name ? ', ' + name : '') + '!\n\n' +
    '📅 ' + fmtRuDate_(s.date) + '\n' +
    (s.time  ? '🕙 ' + fmtTime_(s.time) + '\n' : '') +
    (s.price ? '💰 ' + fmtPrice_(s.price) + '\n' : '') +
    '\nПриедете?';
  return tgSend_(tgId, text, {
    reply_markup: JSON.stringify({ inline_keyboard: [[ { text: 'Ответить →', web_app: { url: url } } ]] })
  });
}

/* ---- форматирование даты/времени/цены (общее для сообщений) ---- */
var SB_MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
var SB_WEEKDAYS = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
function fmtRuDate_(v){
  if (!v) return '';
  var d, m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  else { d = new Date(v); if (isNaN(d.getTime())) return String(v); }
  return d.getDate() + ' ' + SB_MONTHS[d.getMonth()] + ' — ' + SB_WEEKDAYS[d.getDay()];
}
/** ISO-строка даты из любого входа (для нормализации SESSION_DATE). */
function toIsoDate_(v){
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  var d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return Utilities.formatDate(d, CFG.tz, 'yyyy-MM-dd');
}
function fmtTime_(t){ t = normTime_(t); return t ? ('с ' + t) : ''; }
function fmtPrice_(p){ p = String(p || '').replace(/[^\d.,]/g, '').trim(); return !p ? '' : (p + ' руб/кг'); }
/** «С 10» / «10:00» / «10» → «10:00». */
function normTime_(t){
  t = String(t || '').trim();
  var m = t.match(/(\d{1,2})[:.\s]?(\d{2})?/);
  if (!m) return '';
  var hh = ('0' + m[1]).slice(-2), mm = m[2] || '00';
  return hh + ':' + mm;
}

/** После отмены «едущего» — позвать самого раннего из пула (если есть Telegram). */
function Samosbor_inviteNextFromPool_(){
  try {
    var s = Samosbor_settings_();
    if (!s.seasonActive || !s.sessionOpen || !s.date) return;
    var sh = sheet_(SB_REG, SB_REG_COLS);
    var values = sh.getDataRange().getValues();
    var sCol = SB_REG_COLS.indexOf('Статус');
    for (var i = 1; i < values.length; i++){
      if (String(values[i][sCol]).toLowerCase() === SB_ST.POOL && values[i][SB_REG_COLS.indexOf('Telegram_ID')]){
        var rowNum = i + 1, name = values[i][SB_REG_COLS.indexOf('Имя')];
        Samosbor_setFields_(rowNum, {
          'Статус':SB_ST.INVITED, 'Дата_заезда':s.date,
          'Приглашён':Utilities.formatDate(new Date(), CFG.tz, 'dd.MM.yyyy HH:mm')
        });
        Samosbor_sendInvite_(String(values[i][SB_REG_COLS.indexOf('Telegram_ID')]), String(values[i][0]), name, s);
        notifyAdmins_('🔔 Место освободилось — позвали из пула: ' + name);
        return;
      }
    }
  } catch(e){ notifyAdmins_('⚠️ Не смог позвать из пула: ' + e.message); }
}

function Samosbor_regUpdate_(body){
  var id = trim_(body.id);
  var status = trim_(body.status).toLowerCase() || SB_ST.GOING;
  var sh = sheet_(SB_REG, SB_REG_COLS);
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++){
    if (String(values[i][0]) === id){
      var fields = { 'Статус':status };
      if (status === SB_ST.POOL){ fields['Дата_заезда'] = ''; fields['Приглашён'] = ''; }
      Samosbor_setFields_(i + 1, fields);
      return json_({ ok:true });
    }
  }
  return json_({ ok:false, error:'not_found' });
}

function Samosbor_adminUpdate_(body){
  // доступ к админ-странице уже ограничен тегом в LEADTEX — пароль не проверяем
  Samosbor_setSetting_('SEASON_ACTIVE', body.seasonActive ? 'true' : 'false');
  Samosbor_setSetting_('SESSION_OPEN',  body.sessionOpen  ? 'true' : 'false');
  Samosbor_setSetting_('SESSION_DATE',  toIsoDate_(trim_(body.date)));
  Samosbor_setSetting_('SESSION_TIME',  normTime_(body.time));
  Samosbor_setSetting_('SESSION_PRICE', String(body.price || '').replace(/[^\d.,]/g, ''));
  Samosbor_setSetting_('LIMIT',         Math.max(1, Math.floor(Number(body.limit)) || 10));
  return json_({ success:true });
}

/* ==================== настройки / хелперы ==================== */

function Samosbor_setSetting_(key, value){
  var sh = sheet_(SB_SET, SB_SET_COLS);
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++){
    if (trim_(values[i][0]) === key){ sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

function Samosbor_setFields_(rowNum, obj){
  var sh = sheet_(SB_REG, SB_REG_COLS);
  Object.keys(obj).forEach(function(k){
    var col = SB_REG_COLS.indexOf(k) + 1;
    if (col > 0) sh.getRange(rowNum, col).setValue(obj[k]);
  });
}

function clampInt_(v, lo, hi){
  var n = Math.floor(Number(v)) || lo;
  return Math.max(lo, Math.min(hi, n));
}
function fmtCellTs_(v){
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, CFG.tz, 'dd.MM.yyyy HH:mm:ss');
  return String(v == null ? '' : v).trim();
}

/* ==================== меню в таблице ==================== */

/** «Ферма» → «Самосбор: позвать весь пул» — приглашает всех со Статусом «без даты» и Telegram. */
function Samosbor_inviteAllPool(){
  var ui = SpreadsheetApp.getUi();
  var s = Samosbor_settings_();
  if (!s.date){ ui.alert('Сначала задай дату заезда в настройках / админ-странице'); return; }
  var sh = sheet_(SB_REG, SB_REG_COLS);
  var values = sh.getDataRange().getValues();
  var sCol = SB_REG_COLS.indexOf('Статус'), tCol = SB_REG_COLS.indexOf('Telegram_ID'), nCol = SB_REG_COLS.indexOf('Имя');
  var sent = 0, noTg = 0;
  for (var i = 1; i < values.length; i++){
    if (String(values[i][sCol]).toLowerCase() !== SB_ST.POOL) continue;
    if (!values[i][tCol]){ noTg++; continue; }
    Samosbor_setFields_(i + 1, {
      'Статус':SB_ST.INVITED, 'Дата_заезда':s.date,
      'Приглашён':Utilities.formatDate(new Date(), CFG.tz, 'dd.MM.yyyy HH:mm')
    });
    Samosbor_sendInvite_(String(values[i][tCol]), String(values[i][0]), values[i][nCol], s);
    sent++;
  }
  ui.alert('Позвали ' + sent + ' на ' + fmtRuDate_(s.date) + '.\n' + noTg + ' без Telegram — их видно в админке, можно позвонить.');
}
