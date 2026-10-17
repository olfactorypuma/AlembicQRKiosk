/**
 * Alembic Door Kiosk — Google Apps Script (bound to the "Door Kiosk" Google Sheet)
 *
 * What it does
 *   1. sync()  — every 15 min, pulls events from the Momence API, drops cancelled /
 *                online / private events, and writes the upcoming ones to the "Events"
 *                tab. Your edits in the yellow override columns are kept between syncs.
 *   2. doGet() — serves a small public JSON feed (only the fields the kiosk needs) to the
 *                kiosk page. The Momence token never leaves this script.
 *
 * One-time setup: see README.md. In short: Project Settings → Script Properties →
 * add MOMENCE_TOKEN (and optionally MOMENCE_HOST_ID), then run setup() once, then
 * Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 */

var TZ = 'America/Los_Angeles';
var API_URL = 'https://momence.com/_api/primary/api/v1/Events';
var DEFAULT_HOST_ID = '71603';

var SETTINGS_SHEET = 'Settings';
var EVENTS_SHEET = 'Events';
var MANUAL_SHEET = 'Manual';

// key, default value, note shown in the Settings tab
var DEFAULT_SETTINGS = [
  ['doors_before_min', 15, 'Minutes before start that an event\'s QR code appears'],
  ['doors_after_min', 15, 'Minutes after start that it stays up (late arrivals)'],
  ['max_codes_per_screen', 4, '1–4. If more events have doors open, the screen rotates between pages'],
  ['rotate_seconds', 15, 'Seconds per page when rotating QR pages'],
  ['flyer_days_ahead', 30, 'How far ahead the flyer carousel looks'],
  ['flyer_seconds', 12, 'Seconds per flyer when the carousel auto-advances'],
  ['manual_timeout_min', 3, 'After someone taps the mode toggle, return to automatic after this many idle minutes'],
  ['sync_days_ahead', 0, '0 = read only today\'s events from Momence. Raise it to also put future events in the flyer carousel (QR codes stay today-only)'],
  ['exclude_types', 'private', 'Momence event types to skip (comma-separated)'],
  ['room_names', 'Lounge=Tea Lounge; Berkeley Alembic=', 'Rename rooms for display (old=new; blank new = hide room)'],
  ['qr_headline', 'Skip the line — buy your ticket here', 'Big heading on the QR screen'],
  ['qr_subhead', 'Open your phone camera and point it at the code', 'Small line under the heading'],
  ['flyer_headline', 'Coming up at The Berkeley Alembic', 'Heading on the flyer screen']
];

var AUTO_COLS = ['event_id', 'starts', 'start_iso', 'title', 'auto_header', 'auto_subtitle',
  'room', 'duration_min', 'link', 'image', 'recurring', 'sold_out', 'waitlist'];
var OVERRIDE_COLS = ['show_qr', 'header', 'caption', 'doors_before_min', 'doors_after_min',
  'flyer', 'flyer_image'];
var EVENT_COLS = AUTO_COLS.concat(OVERRIDE_COLS);

var MANUAL_COLS = ['enabled', 'type', 'header', 'caption', 'link', 'image', 'show_from', 'show_until'];

/* ------------------------------------------------------------------ */
/* Menu + setup                                                        */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Door Kiosk')
    .addItem('Sync from Momence now', 'sync')
    .addItem('Show feed URL', 'showFeedUrl_')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActive();

  // Settings tab
  var st = ss.getSheetByName(SETTINGS_SHEET) || ss.insertSheet(SETTINGS_SHEET);
  var existing = readSettingsRaw_(st);
  var rows = [['key', 'value', 'note']];
  DEFAULT_SETTINGS.forEach(function (d) {
    rows.push([d[0], existing.hasOwnProperty(d[0]) ? existing[d[0]] : d[1], d[2]]);
  });
  st.clearContents();
  st.getRange(1, 1, rows.length, 3).setValues(rows);
  st.setFrozenRows(1);
  st.getRange(1, 1, 1, 3).setFontWeight('bold');
  st.getRange(2, 2, rows.length - 1, 1).setBackground('#fff8d6');
  st.autoResizeColumns(1, 3);

  // Events tab
  var ev = ss.getSheetByName(EVENTS_SHEET) || ss.insertSheet(EVENTS_SHEET);
  ev.getRange(1, 1, 1, EVENT_COLS.length).setValues([EVENT_COLS]).setFontWeight('bold');
  ev.setFrozenRows(1);
  ev.setFrozenColumns(2);
  ev.getRange(1, AUTO_COLS.length + 1, 1, OVERRIDE_COLS.length).setBackground('#ffe680');
  var oc = function (name) { return EVENT_COLS.indexOf(name) + 1; };
  ev.getRange(2, oc('show_qr'), 1000, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['', 'no', 'pin'], true).setAllowInvalid(false).build());
  ev.getRange(2, oc('flyer'), 1000, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['', 'no', 'yes'], true).setAllowInvalid(false).build());
  ev.getRange(1, oc('show_qr')).setNote('blank = show during its door window · no = never show · pin = show right now, regardless of time');
  ev.getRange(1, oc('header')).setNote('Replaces the automatic short title');
  ev.getRange(1, oc('caption')).setNote('Small line under the title (default: the "with …" part of the title)');
  ev.getRange(1, oc('doors_before_min')).setNote('Per-event override of the Settings value');
  ev.getRange(1, oc('doors_after_min')).setNote('Per-event override of the Settings value');
  ev.getRange(1, oc('flyer')).setNote('blank = include in carousel if within flyer_days_ahead · no = never · yes = always (until it starts)');
  ev.getRange(1, oc('flyer_image')).setNote('Image URL to use instead of the Momence banner (e.g. a portrait-format flyer)');
  ev.getRange(1, oc('start_iso')).setNote('Machine-readable start time. Do not edit.');
  ev.getRange(2, oc('start_iso'), 1000, 1).setNumberFormat('@');

  // Manual tab
  var mn = ss.getSheetByName(MANUAL_SHEET) || ss.insertSheet(MANUAL_SHEET);
  if (mn.getLastRow() < 1) {
    mn.getRange(1, 1, 1, MANUAL_COLS.length).setValues([MANUAL_COLS]).setFontWeight('bold');
    mn.setFrozenRows(1);
    mn.getRange(2, 1, 1, MANUAL_COLS.length).setValues([[false, 'flyer', 'Example: Volunteer with us',
      'Ask at the front desk', 'https://berkeleyalembic.org', '', '', '']]);
  }
  mn.getRange(2, 1, 500, 1).insertCheckboxes();
  mn.getRange(2, 2, 500, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['qr', 'flyer'], true).build());
  mn.getRange(1, 2).setNote('qr = shows as a QR card (between show_from and show_until) · flyer = adds a slide to the carousel');
  mn.getRange(1, 7).setNote('Date/time. Blank = no start limit');
  mn.getRange(1, 8).setNote('Date/time. Blank = no end limit');

  // Trigger: sync every 15 minutes (replace any older copies)
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(15).create();

  var del = ss.getSheetByName('Sheet1');
  if (del && del.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(del);

  sync();
}

function showFeedUrl_() {
  var url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(url ? 'Feed URL:\n' + url :
    'Not deployed yet. Use Deploy → New deployment → Web app first.');
}

/* ------------------------------------------------------------------ */
/* Sync: Momence → Events tab                                          */
/* ------------------------------------------------------------------ */

function sync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  var props = PropertiesService.getScriptProperties();
  try {
    var token = props.getProperty('MOMENCE_TOKEN');
    if (!token) throw new Error('MOMENCE_TOKEN is not set in Script Properties');
    var hostId = props.getProperty('MOMENCE_HOST_ID') || DEFAULT_HOST_ID;
    var url = API_URL + '?hostId=' + encodeURIComponent(hostId) + '&token=' + encodeURIComponent(token);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error('Momence returned HTTP ' + res.getResponseCode()); // never log the URL (it holds the token)
    }
    var raw = JSON.parse(res.getContentText());
    if (!Array.isArray(raw)) throw new Error('Unexpected Momence response (not a list)');

    var ss = SpreadsheetApp.getActive();
    var settings = readSettings_(ss);
    var rows = normalizeEvents_(raw, settings, Date.now(), fmtLA_);
    writeEvents_(ss.getSheetByName(EVENTS_SHEET), rows);

    props.setProperty('LAST_SYNC', new Date().toISOString());
    props.deleteProperty('LAST_SYNC_ERROR');
    CacheService.getScriptCache().remove('feed');
  } catch (err) {
    props.setProperty('LAST_SYNC_ERROR', new Date().toISOString() + ' ' + String(err.message || err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/** Pure: Momence events → sorted row objects (no Google services used; testable). */
function normalizeEvents_(raw, settings, nowMs, fmt) {
  var exclude = String(settings.exclude_types || '').toLowerCase().split(',')
    .map(function (s) { return s.trim(); }).filter(String);
  var rooms = parseRoomMap_(settings.room_names);
  var today = fmt(new Date(nowMs), 'yyyy-MM-dd');
  var days = Math.max(0, Number(settings.sync_days_ahead) || 0);
  var lastDay = fmt(new Date(nowMs + days * 86400000), 'yyyy-MM-dd'); // compare calendar days in Pacific time

  var out = [];
  var seen = {};
  raw.forEach(function (e) {
    if (!e || seen[e.id]) return;
    if (e.isCancelled || e.isDeleted || e.published === false || e.online) return;
    if (exclude.indexOf(String(e.type || '').toLowerCase()) !== -1) return;
    var start = new Date(e.dateTime);
    if (isNaN(start.getTime())) return;
    var day = fmt(start, 'yyyy-MM-dd');
    if (day < today || day > lastDay) return;
    seen[e.id] = true;

    var room = String(e.location || '').trim();
    if (rooms.hasOwnProperty(room)) room = rooms[room];
    var hs = autoHeader_(e.title);
    var soldOut = e.spotsRemaining === 0 && e.capacity != null;
    out.push({
      event_id: String(e.id),
      starts: fmt(start, 'EEE M/d h:mm a'),
      start_iso: start.toISOString(),
      title: String(e.title || '').trim(),
      auto_header: hs.header,
      auto_subtitle: hs.subtitle,
      room: room,
      duration_min: (e.duration == null || e.duration === '') ? '' : Number(e.duration),
      link: String(e.link || ''),
      image: String(e.image1 || ''),
      recurring: (e.tags || []).indexOf('recurring') !== -1,
      sold_out: soldOut,
      waitlist: !!e.allowWaitlist
    });
  });
  out.sort(function (a, b) { return a.start_iso < b.start_iso ? -1 : a.start_iso > b.start_iso ? 1 : 0; });
  return out;
}

/** Pure: shorten a long Momence title to a display header + "with …" subtitle. */
function autoHeader_(title) {
  var t = String(title || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*\((online[^)]*|in[- ]person[^)]*)\)\s*$/i, '');
  var subtitle = '';
  // last "with <Capitalized name>" → subtitle ("Listening with a New…" is left alone)
  var m = t.match(/^(.{6,})\s+(?:with|w\/|led by|featuring)\s+([A-ZÀ-ɏ].*)$/);
  if (m && !/^(A|An|The)\s/.test(m[2])) { t = m[1].replace(/[\s,:;–—-]+$/, ''); subtitle = 'with ' + m[2]; }
  var MAX = 60;
  if (t.length > MAX) t = t.replace(/\s*\([^)]*\)\s*$/, ''); // drop a trailing (aside)
  if (t.length > MAX) {
    var full = t;
    // longest prefix ending at a natural break (: ? ! — –) that fits
    var best = '';
    var re = /[:?!]|\s[—–-]\s/g, mm;
    while ((mm = re.exec(t)) !== null) {
      var end = mm.index + (mm[0] === '?' || mm[0] === '!' ? 1 : 0);
      var cand = t.slice(0, end).trim();
      if (cand.length >= 8 && cand.length <= MAX) best = cand;
    }
    if (!best) {
      best = t.slice(0, MAX - 1);
      best = best.slice(0, best.lastIndexOf(' ') > 30 ? best.lastIndexOf(' ') : best.length)
        .replace(/[\s,:;–—-]+$/, '') + '…';
    } else if (!subtitle) {
      subtitle = full.slice(best.length).replace(/^[\s:?!—–-]+/, ''); // keep the cut-off part as subtitle
    }
    t = best;
  }
  return { header: t, subtitle: subtitle };
}

function parseRoomMap_(s) {
  var map = {};
  String(s || '').split(';').forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i > 0) map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return map;
}

function writeEvents_(sheet, rows) {
  // Keep the yellow override columns, keyed by event_id
  var last = sheet.getLastRow();
  var keep = {};
  if (last > 1) {
    var data = sheet.getRange(2, 1, last - 1, EVENT_COLS.length).getValues();
    var idCol = EVENT_COLS.indexOf('event_id');
    data.forEach(function (r) {
      var o = {}, any = false;
      OVERRIDE_COLS.forEach(function (c) {
        var v = r[EVENT_COLS.indexOf(c)];
        o[c] = v;
        if (v !== '' && v !== null) any = true;
      });
      if (any) keep[String(r[idCol])] = o;
    });
  }
  var values = rows.map(function (row) {
    var o = keep[row.event_id] || {};
    return EVENT_COLS.map(function (c) {
      if (row.hasOwnProperty(c)) return row[c];
      return o.hasOwnProperty(c) ? o[c] : '';
    });
  });
  if (last > 1) sheet.getRange(2, 1, last - 1, EVENT_COLS.length).clearContent();
  if (values.length) {
    sheet.getRange(2, EVENT_COLS.indexOf('start_iso') + 1, values.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, values.length, EVENT_COLS.length).setValues(values);
  }
}

/* ------------------------------------------------------------------ */
/* Feed: Sheet → JSON for the kiosk page                               */
/* ------------------------------------------------------------------ */

function doGet(e) {
  var cache = CacheService.getScriptCache();
  var json = cache.get('feed');
  if (!json) {
    json = JSON.stringify(buildFeed_());
    try { cache.put('feed', json, 60); } catch (ignore) { /* >100KB: skip cache */ }
  }
  var cb = e && e.parameter && e.parameter.callback;
  if (cb && /^[A-Za-z_$][\w$.]{0,60}$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function buildFeed_() {
  var ss = SpreadsheetApp.getActive();
  var settings = readSettings_(ss);
  var props = PropertiesService.getScriptProperties();

  var events = [];
  var ev = ss.getSheetByName(EVENTS_SHEET);
  if (ev && ev.getLastRow() > 1) {
    ev.getRange(2, 1, ev.getLastRow() - 1, EVENT_COLS.length).getValues().forEach(function (r) {
      var o = {};
      EVENT_COLS.forEach(function (c, i) { o[c] = r[i]; });
      if (!o.event_id || !o.start_iso) return;
      events.push(feedEvent_(o));
    });
  }

  var manual = [];
  var mn = ss.getSheetByName(MANUAL_SHEET);
  if (mn && mn.getLastRow() > 1) {
    mn.getRange(2, 1, mn.getLastRow() - 1, MANUAL_COLS.length).getValues().forEach(function (r, i) {
      var o = {};
      MANUAL_COLS.forEach(function (c, j) { o[c] = r[j]; });
      if (o.enabled !== true || !(o.header || o.image)) return;
      manual.push({
        id: 'm' + (i + 2),
        type: String(o.type || 'flyer').toLowerCase() === 'qr' ? 'qr' : 'flyer',
        header: String(o.header || ''),
        caption: String(o.caption || ''),
        link: String(o.link || ''),
        image: String(o.image || ''),
        from: o.show_from instanceof Date ? o.show_from.toISOString() : '',
        until: o.show_until instanceof Date ? o.show_until.toISOString() : ''
      });
    });
  }

  var s = {};
  DEFAULT_SETTINGS.forEach(function (d) {
    if (['sync_days_ahead', 'exclude_types', 'room_names'].indexOf(d[0]) === -1) s[d[0]] = settings[d[0]];
  });

  return {
    generated: new Date().toISOString(),
    lastSync: props.getProperty('LAST_SYNC') || '',
    syncError: props.getProperty('LAST_SYNC_ERROR') || '',
    settings: s,
    events: events,
    manual: manual
  };
}

/** Pure: sheet row object → public feed event. */
function feedEvent_(o) {
  var num = function (v) { return (v === '' || v === null || isNaN(Number(v))) ? null : Number(v); };
  var flag = function (v) { return String(v || '').trim().toLowerCase(); };
  var bool = function (v) { return v === true || String(v).toUpperCase() === 'TRUE'; };
  return {
    id: String(o.event_id),
    header: String(o.header || o.auto_header || o.title || ''),
    caption: String(o.caption || o.auto_subtitle || ''),
    room: String(o.room || ''),
    start: String(o.start_iso),
    durationMin: num(o.duration_min),
    link: String(o.link || ''),
    image: String(o.flyer_image || o.image || ''),
    recurring: bool(o.recurring),
    soldOut: bool(o.sold_out),
    waitlist: bool(o.waitlist),
    showQr: flag(o.show_qr) || 'auto',
    flyer: flag(o.flyer) || 'auto',
    doorsBefore: num(o.doors_before_min),
    doorsAfter: num(o.doors_after_min)
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function readSettingsRaw_(sheet) {
  var out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
    if (r[0] !== '') out[String(r[0]).trim()] = r[1];
  });
  return out;
}

function readSettings_(ss) {
  var raw = readSettingsRaw_(ss.getSheetByName(SETTINGS_SHEET));
  var s = {};
  DEFAULT_SETTINGS.forEach(function (d) {
    var v = raw.hasOwnProperty(d[0]) && raw[d[0]] !== '' ? raw[d[0]] : d[1];
    s[d[0]] = (typeof d[1] === 'number') ? (isNaN(Number(v)) ? d[1] : Number(v)) : String(v);
  });
  return s;
}

function fmtLA_(date, pattern) {
  return Utilities.formatDate(date, TZ, pattern);
}
