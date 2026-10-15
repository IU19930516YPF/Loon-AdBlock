// virtual-location-settings.js —— 虚拟定位设置接口（独立自研）
// 拦截 https://gs-loc.apple.com/wloc-settings/save 的请求：
//   ?lon=X&lat=Y&acc=Z  → 保存坐标到设备持久化存储
//   ?action=query       → 查询当前保存的坐标（JSON）
//   ?action=clear       → 清除保存的坐标
// 供地图选点页面调用（"储存到设备"按钮）。
'use strict';

var STORE_KEY = 'virtual_location_settings';

function jsonResponse(obj) {
  var body;
  try { body = JSON.stringify(obj); } catch (e) { body = '{"success":false}'; }
  $done({
    response: {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      },
      body: body
    }
  });
}

function readSaved() {
  try {
    var s = (typeof $persistentStore !== 'undefined') ? $persistentStore.read(STORE_KEY) : null;
    if (s) {
      var o = JSON.parse(s);
      if (o && isFinite(o.lng) && isFinite(o.lat)) return o;
    }
  } catch (e) {}
  return null;
}

(function main() {
  try {
    var url = ($request && $request.url) || '';
    var qi = url.indexOf('?');
    var query = qi >= 0 ? url.slice(qi + 1) : '';
    var params = {};
    query.split('&').forEach(function (p) {
      var i = p.indexOf('=');
      if (i > 0) {
        try { params[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1)); }
        catch (e) { params[p.slice(0, i)] = p.slice(i + 1); }
      }
    });

    if (params.action === 'query') {
      var saved = readSaved();
      if (saved) {
        jsonResponse({ success: true, longitude: saved.lng, latitude: saved.lat,
                       accuracy: saved.acc || 25, randomRadius: 0 });
      } else {
        jsonResponse({ success: false, error: 'no saved location' });
      }
      return;
    }

    if (params.action === 'clear') {
      try { $persistentStore.write('{}', STORE_KEY); } catch (e) {}
      jsonResponse({ success: true });
      return;
    }

    var lng = parseFloat(params.lon);
    var lat = parseFloat(params.lat);
    var acc = parseInt(params.acc || '25', 10);
    if (!isFinite(lng) || !isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      jsonResponse({ success: false, error: 'invalid coordinates' });
      return;
    }
    try {
      $persistentStore.write(JSON.stringify({ lng: lng, lat: lat, acc: acc || 25 }), STORE_KEY);
      jsonResponse({ success: true });
    } catch (e) {
      jsonResponse({ success: false, error: 'write failed: ' + (e && e.message || e) });
    }
  } catch (e) {
    try { $done({}); } catch (e2) {}
  }
})();
