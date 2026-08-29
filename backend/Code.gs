/* ============================================================
   ФЕРМА — общий бэкенд (Apps Script). Роутер + общие хелперы.

   Одна таблица «Ферма», одно развёртывание /exec, три клиента:
     instrument-lyuban.html         → area=tool
     samosbor_registraciya_web.html → area=samosbor (клиент)
     samosbor_admin.html            → area=samosbor (управление)

   Логика по темам — в отдельных файлах: Tool.gs, Samosbor.gs.
   Настройки — Config.gs. Установка/триггеры/миграция — Setup.gs.

   Роутинг: по ?area= (tool|samosbor); если не задан — определяется
   по имени action; если и action нет — считаем samosbor (его клиент
   дёргает bare GET за статусом).
   ============================================================ */

function doGet(e){
  e = e || {};
  var p = e.parameter || {};
  try{
    if (p.action === 'ping') return json_({ ok:true, time:nowIso_() });
    if (CFG.requireTgAuth){
      var a = verifyInitData_(p.initData);
      if (!a.ok) return json_({ ok:false, error:'auth: ' + a.reason, code:'AUTH' });
    }
    var area = p.area || areaByAction_(p.action) || 'samosbor';
    return area === 'tool' ? Tool_get(p) : Samosbor_get(p);
  }catch(err){
    return json_({ ok:false, error:String(err), code:'EXCEPTION' });
  }
}

function doPost(e){
  var body = {};
  try{ body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch(err){ return json_({ ok:false, error:'bad json', code:'BAD_JSON' }); }

  try{
    if (CFG.requireTgAuth){
      var a = verifyInitData_(body.initData);
      if (!a.ok) return json_({ ok:false, error:'auth: ' + a.reason, code:'AUTH' });
      body._user = a.user;
    }
    var area = body.area || areaByAction_(body.action) || 'samosbor';
    return withLock_(function(){
      return area === 'tool' ? Tool_post(body) : Samosbor_post(body);
    });
  }catch(err){
    return json_({ ok:false, error:String(err), code:'EXCEPTION' });
  }
}

function areaByAction_(a){
  if (!a) return null;
  if (['list','add','return','extend','confirm'].indexOf(a) >= 0) return 'tool';
  if (['status','regs','register','waitlist','cancel','adminUpdate'].indexOf(a) >= 0) return 'samosbor';
  return null;
}

/* ==================== Общие хелперы ==================== */

function ss_(){
  if (!CFG.farmSheetId) throw new Error('FARM_SHEET_ID не задан (Config.gs → setConfig)');
  return SpreadsheetApp.openById(CFG.farmSheetId);
}

function sheet_(name, headers){
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh){
    sh = ss.insertSheet(name);
    if (headers && headers.length){ sh.appendRow(headers); sh.setFrozenRows(1); }
  }
  return sh;
}

/** Читает лист в массив объектов по ЗАГОЛОВКАМ (порядок колонок не важен). */
function readObjects_(name, headers){
  var sh = sheet_(name, headers);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var idx = {};
  values[0].forEach(function(h, i){ idx[String(h).trim()] = i; });
  var out = [];
  for (var r = 1; r < values.length; r++){
    var row = values[r], o = { _row: r + 1 };
    headers.forEach(function(h){ o[h] = (idx[h] != null) ? row[idx[h]] : ''; });
    out.push(o);
  }
  return out;
}

function appendRow_(name, headers, obj){
  sheet_(name, headers).appendRow(headers.map(function(h){
    return (obj[h] === null || obj[h] === undefined) ? '' : obj[h];
  }));
}

function setCell_(name, headers, row, header, value){
  var sh = sheet_(name, headers);
  var col = headers.indexOf(header) + 1;
  if (col > 0) sh.getRange(row, col).setValue(value);
}

function withLock_(fn){
  var lock = LockService.getScriptLock();
  try{ lock.waitLock(20000); }
  catch(e){ return json_({ ok:false, error:'сервер занят, повтори через секунду', code:'LOCK_TIMEOUT' }); }
  try{ return fn(); }
  finally{ try{ lock.releaseLock(); }catch(e){} }
}

function json_(o){
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function trim_(v){ return String(v == null ? '' : v).trim(); }
function truthy_(v){
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'да' || s === 'yes' || s === 'x' || s === '+';
}

function nowIso_(){ return Utilities.formatDate(new Date(), CFG.tz, "yyyy-MM-dd'T'HH:mm:ss"); }
function todayStr_(){ return Utilities.formatDate(new Date(), CFG.tz, 'yyyy-MM-dd'); }

function isDateStr_(s){
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00'));
}
function ymd_(v){
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, CFG.tz, 'yyyy-MM-dd');
  var s = trim_(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00'))) return s;
  return '';
}
function fmtDateCell_(v){
  if (!v) return '';
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, CFG.tz, 'yyyy-MM-dd');
  var s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}
function fmtRu_(s){
  var v = ymd_(s);
  if (!v) return s || '—';
  var p = v.split('-');
  return p[2] + '.' + p[1] + '.' + p[0];
}
function addMonthsStr_(dateStr, n){
  var d = new Date((dateStr || todayStr_()) + 'T00:00:00');
  d.setMonth(d.getMonth() + Number(n));
  return Utilities.formatDate(d, CFG.tz, 'yyyy-MM-dd');
}
function addDaysStr_(dateStr, n){
  var d = new Date((dateStr || todayStr_()) + 'T00:00:00');
  d.setDate(d.getDate() + Number(n));
  return Utilities.formatDate(d, CFG.tz, 'yyyy-MM-dd');
}
function daysBetweenStr_(a, b){
  return Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
}
function plural_(n, one, few, many){
  var a = Math.abs(n) % 100, b = a % 10, w = many;
  if (b === 1 && a !== 11) w = one;
  else if (b >= 2 && b <= 4 && (a < 10 || a >= 20)) w = few;
  return n + ' ' + w;
}
function esc_(s){
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function digits_(s){ return String(s == null ? '' : s).replace(/\D/g, ''); }

/* ==================== Telegram ==================== */

function tgSend_(chatId, text, opts){
  if (!CFG.botToken || !chatId) return false;
  var payload = Object.assign({
    chat_id: String(chatId), text: text, disable_web_page_preview: true
  }, opts || {});
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + CFG.botToken + '/sendMessage', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) Logger.log('Telegram ' + res.getResponseCode() + ': ' + res.getContentText());
  return res.getResponseCode() === 200;
}
function notifyAdmins_(text, opts){
  CFG.notifyIds.forEach(function(id){ try{ tgSend_(id, text, opts); }catch(e){} });
}

/* ==================== Проверка initData (по флагу) ==================== */

function verifyInitData_(initData){
  if (!CFG.botToken) return { ok:false, reason:'BOT_TOKEN не задан' };
  if (!initData)     return { ok:false, reason:'нет initData' };
  var map = {};
  String(initData).split('&').forEach(function(p){
    var i = p.indexOf('=');
    if (i >= 0) map[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1));
  });
  var hash = map.hash; delete map.hash;
  if (!hash) return { ok:false, reason:'нет hash' };
  var dcs = Object.keys(map).sort().map(function(k){ return k + '=' + map[k]; }).join('\n');
  var secret = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(CFG.botToken).getBytes(), Utilities.newBlob('WebAppData').getBytes());
  var check = Utilities.computeHmacSha256Signature(Utilities.newBlob(dcs).getBytes(), secret);
  var hex = '';
  for (var j = 0; j < check.length; j++){
    var b = check[j] < 0 ? check[j] + 256 : check[j];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  if (hex !== String(hash).toLowerCase()) return { ok:false, reason:'подпись не совпала' };
  var authDate = Number(map.auth_date || 0) * 1000;
  if (!authDate || (Date.now() - authDate) > 24 * 3600 * 1000) return { ok:false, reason:'initData устарел' };
  var user = null;
  try{ user = map.user ? JSON.parse(map.user) : null; }catch(e){}
  return { ok:true, user:user };
}
