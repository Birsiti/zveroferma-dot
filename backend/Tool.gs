/* ============================================================
   ФЕРМА · тема «Инструмент» (Любань).

   Листы таблицы «Ферма»:
     Инструмент — id | item | who | issued | confirm | returned | by
                  | confirmedAt | confirmedBy | qty | returnedQty | comment
     Журнал     — ts | action | id | reqId | who | item | qty | by | note

   Клиент: instrument-lyuban.html (area=tool).
     GET  ?area=tool&action=list          → { ok, records:[…] }
     POST { action:'add', … , reqId }     → { ok, record }
     POST { action:'return', id, qty, returned, reqId }
     POST { action:'extend', id, confirm, reqId }
     POST { action:'confirm', id, confirmedAt, confirmedBy, confirm, reqId }

   Идемпотентность по reqId (лист «Журнал»), запись под общим LockService
   из роутера. Ежедневный триггер Tool_sendReminders (ставит Setup → setup()).
   ============================================================ */

var TOOL_SHEET = 'Инструмент';
var TOOL_LOG   = 'Журнал';
var TOOL_COLS  = ['id','item','who','issued','confirm','returned','by','confirmedAt','confirmedBy','qty','returnedQty','comment'];
var TOOL_LOG_COLS = ['ts','action','id','reqId','who','item','qty','by','note'];

/* ---------- GET ---------- */

function Tool_get(p){
  if (p.action === 'history'){
    var id = String(p.id || '');
    var evs = readObjects_(TOOL_LOG, TOOL_LOG_COLS)
      .filter(function(x){ return String(x.id) === id; });
    return json_({ ok:true, events: evs });
  }
  return json_({ ok:true, records: Tool_readRecords_() });
}

/* ---------- POST ---------- */

function Tool_post(body){
  switch (body.action){
    case 'add':     return Tool_add_(body);
    case 'return':  return Tool_return_(body);
    case 'extend':  return Tool_extend_(body);
    case 'confirm': return Tool_confirm_(body);
    default:        return json_({ ok:false, error:'unknown tool action', code:'BAD_ACTION' });
  }
}

/* ---------- чтение / проекция ---------- */

function Tool_readRecords_(){
  return readObjects_(TOOL_SHEET, TOOL_COLS)
    .filter(function(r){ return r.id !== '' && r.id != null && !truthy_(r.void); })
    .map(Tool_row_);
}
function Tool_row_(r){
  return {
    id: Number(r.id) || r.id,
    item: r.item, who: r.who,
    issued: fmtDateCell_(r.issued),
    confirm: fmtDateCell_(r.confirm),
    returned: r.returned ? fmtDateCell_(r.returned) : null,
    by: r.by || null,
    confirmedAt: r.confirmedAt ? fmtDateCell_(r.confirmedAt) : null,
    confirmedBy: r.confirmedBy || null,
    qty: Number(r.qty) || 1,
    returnedQty: Number(r.returnedQty) || 0,
    comment: r.comment || ''
  };
}
function Tool_find_(id){
  var values = sheet_(TOOL_SHEET, TOOL_COLS).getDataRange().getValues();
  for (var i = 1; i < values.length; i++){
    if (String(values[i][0]) === String(id)) return { row: i + 1, values: values[i] };
  }
  return null;
}
function Tool_byId_(id){ var f = Tool_find_(id); return f ? Tool_row_(rowObj_(TOOL_COLS, f.values)) : null; }
function rowObj_(cols, arr){ var o = {}; cols.forEach(function(c, i){ o[c] = arr[i]; }); return o; }

function Tool_seenReq_(reqId){
  if (!reqId) return null;
  var v = sheet_(TOOL_LOG, TOOL_LOG_COLS).getDataRange().getValues();
  for (var i = v.length - 1; i >= 1; i--){
    if (String(v[i][3]) === String(reqId)) return { action:v[i][1], id:v[i][2] };
  }
  return null;
}
function Tool_log_(o){
  appendRow_(TOOL_LOG, TOOL_LOG_COLS, {
    ts: nowIso_(), action:o.action || '', id:o.id != null ? o.id : '', reqId:o.reqId || '',
    who:o.who || '', item:o.item || '', qty:o.qty != null ? o.qty : '', by:o.by || '', note:o.note || ''
  });
}

/* ---------- операции ---------- */

function Tool_add_(body){
  var reqId = trim_(body.reqId || body.req_id);
  if (reqId){
    var seen = Tool_seenReq_(reqId);
    if (seen) return json_({ ok:true, idempotent:true, id:Number(seen.id), record: Tool_byId_(seen.id) });
  }
  var item    = trim_(body.item);
  var who     = trim_(body.who);
  var by      = trim_(body.by) || 'Кто-то из своих';
  var comment = trim_(body.comment);
  var qty     = Math.floor(Number(body.qty));
  var issued  = ymd_(body.issued) || todayStr_();
  var confirm = ymd_(body.confirm) || addMonthsStr_(issued, 3);

  if (!item)                      return badT_('не указан инструмент');
  if (!who)                       return badT_('не указано, кому выдан');
  if (!(qty >= 1 && qty <= 9999)) return badT_('некорректное количество');

  var values = sheet_(TOOL_SHEET, TOOL_COLS).getDataRange().getValues();
  var maxId = 0;
  for (var i = 1; i < values.length; i++){ var n = Number(values[i][0]); if (n > maxId) maxId = n; }
  var id = maxId + 1;

  appendRow_(TOOL_SHEET, TOOL_COLS, {
    id:id, item:item, who:who, issued:issued, confirm:confirm, returned:'',
    by:by, confirmedAt:'', confirmedBy:'', qty:qty, returnedQty:0, comment:comment
  });
  Tool_log_({ action:'add', id:id, reqId:reqId, who:who, item:item, qty:qty, by:by, note:comment });

  var rec = Tool_byId_(id);
  notifyAdmins_(Tool_addMessage_(by, rec));
  return json_({ ok:true, id:id, record: rec });
}

function Tool_return_(body){
  var reqId = trim_(body.reqId || body.req_id);
  if (reqId && Tool_seenReq_(reqId)) return json_({ ok:true, idempotent:true, record: Tool_byId_(body.id) });

  var f = Tool_find_(body.id);
  if (!f) return json_({ ok:false, error:'выдача не найдена', code:'NOT_FOUND' });

  var o = rowObj_(TOOL_COLS, f.values);
  var totalQty  = Number(o.qty) || 1;
  var already   = Number(o.returnedQty) || 0;
  var remaining = totalQty - already;
  if (remaining <= 0) return json_({ ok:false, error:'уже возвращено полностью', code:'STATE' });

  var qty = Math.floor(Number(body.qty)) || remaining;
  if (!(qty >= 1)) return badT_('некорректное количество');
  if (qty > remaining) qty = remaining;

  var dateStr = ymd_(body.returned) || todayStr_();
  var newReturned = already + qty;
  var fully = newReturned >= totalQty;

  setCell_(TOOL_SHEET, TOOL_COLS, f.row, 'returnedQty', newReturned);
  if (fully) setCell_(TOOL_SHEET, TOOL_COLS, f.row, 'returned', dateStr);

  Tool_log_({ action:'return', id:o.id, reqId:reqId, who:o.who, item:o.item, qty:qty,
              by:trim_(body.by), note: fully ? 'возвращено полностью' : ('возвращено ' + newReturned + '/' + totalQty) });

  return json_({ ok:true, result:{ fullyReturned:fully, returnedQty:newReturned, totalQty:totalQty },
                 record: Tool_byId_(o.id) });
}

function Tool_extend_(body){
  var reqId = trim_(body.reqId || body.req_id);
  if (reqId && Tool_seenReq_(reqId)) return json_({ ok:true, idempotent:true, record: Tool_byId_(body.id) });
  var f = Tool_find_(body.id);
  if (!f) return json_({ ok:false, error:'выдача не найдена', code:'NOT_FOUND' });
  var o = rowObj_(TOOL_COLS, f.values);
  var confirm = ymd_(body.confirm) || addMonthsStr_(todayStr_(), 3);
  setCell_(TOOL_SHEET, TOOL_COLS, f.row, 'confirm', confirm);
  Tool_log_({ action:'extend', id:o.id, reqId:reqId, who:o.who, item:o.item, by:trim_(body.by), note:'новый срок ' + confirm });
  return json_({ ok:true, record: Tool_byId_(o.id) });
}

function Tool_confirm_(body){
  var reqId = trim_(body.reqId || body.req_id);
  if (reqId && Tool_seenReq_(reqId)) return json_({ ok:true, idempotent:true, record: Tool_byId_(body.id) });
  var f = Tool_find_(body.id);
  if (!f) return json_({ ok:false, error:'выдача не найдена', code:'NOT_FOUND' });
  var o = rowObj_(TOOL_COLS, f.values);
  if (o.returned) return json_({ ok:false, error:'выдача уже закрыта', code:'STATE' });

  var confirmedAt = ymd_(body.confirmedAt) || todayStr_();
  var confirmedBy = trim_(body.confirmedBy) || trim_(body.by) || '';
  var confirm     = ymd_(body.confirm) || addMonthsStr_(todayStr_(), 3);

  setCell_(TOOL_SHEET, TOOL_COLS, f.row, 'confirmedAt', confirmedAt);
  setCell_(TOOL_SHEET, TOOL_COLS, f.row, 'confirmedBy', confirmedBy);
  setCell_(TOOL_SHEET, TOOL_COLS, f.row, 'confirm', confirm);
  Tool_log_({ action:'confirm', id:o.id, reqId:reqId, who:o.who, item:o.item, by:confirmedBy,
              note:'ещё нужен, следующая проверка ' + confirm });
  return json_({ ok:true, record: Tool_byId_(o.id) });
}

function badT_(msg){ return json_({ ok:false, error:msg, code:'VALIDATION' }); }

/* ---------- уведомления ---------- */

function Tool_addMessage_(by, rec){
  var qtyLine     = rec.qty > 1 ? ('Количество: ' + rec.qty + '\n') : '';
  var commentLine = rec.comment ? ('Комментарий: ' + rec.comment + '\n') : '';
  return '🔧 Выдача инструмента\n' +
    'Кто выдал: ' + (by || '—') + '\n' +
    'Инструмент: ' + rec.item + '\n' +
    'Кому: ' + rec.who + '\n' + qtyLine +
    'Дата: ' + fmtRu_(rec.issued) + '\n' + commentLine +
    'Напомнить до: ' + fmtRu_(rec.confirm);
}

/* ---------- напоминания (ежедневный триггер) ---------- */

function Tool_sendReminders(){
  var today   = todayStr_();
  var horizon = CFG.remindBeforeDays > 0 ? addDaysStr_(today, CFG.remindBeforeDays) : today;
  var sent    = Tool_getRemindMap_();
  var recs    = Tool_readRecords_();

  var due = recs.filter(function(r){
    if (r.returned || !r.confirm) return false;
    if (r.confirm > horizon) return false;
    var last = sent[String(r.id)];
    return !last || daysBetweenStr_(today, last) >= CFG.remindRepeatDays;
  });

  if (!due.length){ Tool_pruneRemindMap_(recs); return; }

  var lines = due.sort(function(a, b){ return String(a.confirm).localeCompare(String(b.confirm)); })
    .map(function(r){
      var over = daysBetweenStr_(today, r.confirm);
      var tail = over > 0 ? ('просрочено на ' + plural_(over, 'день', 'дня', 'дней'))
               : over === 0 ? 'срок сегодня' : ('срок через ' + plural_(-over, 'день', 'дня', 'дней'));
      var left = r.qty > 1 ? (' ×' + (r.qty - r.returnedQty) + ' из ' + r.qty) : '';
      return '• ' + r.item + left + ' — у ' + r.who + ' (выдал: ' + (r.by || '—') + '), ' + fmtRu_(r.confirm) + ' — ' + tail;
    });

  notifyAdmins_('⏰ Пора напомнить о возврате (' + due.length + '):\n\n' + lines.join('\n'));

  due.forEach(function(r){ sent[String(r.id)] = today; });
  Tool_saveRemindMap_(sent);
  Tool_pruneRemindMap_(recs);
}

function Tool_getRemindMap_(){
  try{ return JSON.parse(PropertiesService.getScriptProperties().getProperty('toolRemindMap') || '{}'); }
  catch(e){ return {}; }
}
function Tool_saveRemindMap_(m){
  PropertiesService.getScriptProperties().setProperty('toolRemindMap', JSON.stringify(m));
}
function Tool_pruneRemindMap_(recs){
  var alive = {}, m = Tool_getRemindMap_();
  recs.forEach(function(r){ var k = String(r.id); if (!r.returned && m[k]) alive[k] = m[k]; });
  Tool_saveRemindMap_(alive);
}
function Tool_runRemindersNow(){ Tool_sendReminders(); }
