// virtual-location.js —— Apple 网络定位坐标修改（独立自研实现）
// 原理：MITM 拦截 gs-loc.apple.com/clls/wloc 的 protobuf 响应，
//       将其中的经纬度替换为用户设定的坐标，实现虚拟定位。
//
// protobuf 结构（实测）：
//   顶层 field 2 (LEN) → WiFi 区 → field 2 (LEN, repeated) → AP条目 {1:纬度×1e8, 2:经度×1e8, 3:精度}
//   顶层 field 22/24 (LEN) → 蜂窝区 → field 5 (LEN, repeated) → 基站条目 {同上}
// 其余字段原样透传。未设置坐标或解析失败时原样透传，绝不破坏定位服务。
'use strict';

var SCALE = 100000000; // 坐标放大系数 1e8

// ---------- varint 编解码（64 位有符号） ----------
function decodeVarint(u8, pos) {
  var result = 0n, shift = 0n;
  while (pos < u8.length) {
    var b = BigInt(u8[pos++]);
    result |= (b & 0x7Fn) << shift;
    if ((b & 0x80n) === 0n) break;
    shift += 7n;
    if (shift >= 64n) throw new Error('varint too long');
  }
  if (result >= 0x8000000000000000n) result -= 0x10000000000000000n;
  return { value: result, next: pos };
}

function encodeVarint(v) {
  var n = BigInt(v);
  if (n < 0n) n += 0x10000000000000000n; // 负数按 64 位补码编码
  var out = [];
  while (n >= 0x80n) { out.push(Number((n & 0x7Fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n));
  return Uint8Array.from(out);
}

function concatBytes(arrays) {
  var total = 0, i;
  for (i = 0; i < arrays.length; i++) total += arrays[i].length;
  var out = new Uint8Array(total), pos = 0;
  for (i = 0; i < arrays.length; i++) { out.set(arrays[i], pos); pos += arrays[i].length; }
  return out;
}

function encodeField(fieldNo, wireType, payload) {
  var tag = encodeVarint((BigInt(fieldNo) << 3n) | BigInt(wireType));
  var body;
  if (wireType === 0) body = encodeVarint(payload);
  else if (wireType === 2) body = concatBytes([encodeVarint(BigInt(payload.length)), payload]);
  else body = payload; // wireType 1/5 定长，已按尺寸传入
  return concatBytes([tag, body]);
}

function parseMessage(u8) {
  var fields = [], pos = 0;
  while (pos < u8.length) {
    var start = pos;
    var tagR = decodeVarint(u8, pos); pos = tagR.next;
    var fieldNo = Number(tagR.value >> 3n);
    var wireType = Number(tagR.value & 7n);
    var value;
    if (wireType === 0) {
      var r = decodeVarint(u8, pos); value = r.value; pos = r.next;
    } else if (wireType === 2) {
      var lr = decodeVarint(u8, pos); var len = Number(lr.value); pos = lr.next;
      if (pos + len > u8.length) throw new Error('truncated LEN');
      value = u8.slice(pos, pos + len); pos += len;
    } else if (wireType === 5) {
      if (pos + 4 > u8.length) throw new Error('truncated 32bit');
      value = u8.slice(pos, pos + 4); pos += 4;
    } else if (wireType === 1) {
      if (pos + 8 > u8.length) throw new Error('truncated 64bit');
      value = u8.slice(pos, pos + 8); pos += 8;
    } else {
      throw new Error('unsupported wire type ' + wireType);
    }
    fields.push({ fieldNo: fieldNo, wireType: wireType, value: value, raw: u8.slice(start, pos) });
  }
  return fields;
}

// ---------- 坐标替换 ----------
function replaceLocation(msgBytes, lat, lng, acc, stats) {
  var fields = parseMessage(msgBytes), i;
  var latV = null, lngV = null;
  for (i = 0; i < fields.length; i++) {
    if (fields[i].fieldNo === 1 && fields[i].wireType === 0) latV = fields[i].value;
    if (fields[i].fieldNo === 2 && fields[i].wireType === 0) lngV = fields[i].value;
  }
  if (latV === null || lngV === null) return msgBytes; // 不是定位条目，原样返回
  // 合理性校验：原始值必须是合法经纬度范围（度数 x 1e8），否则可能是其他协议的数据，绝不碰
  // varint 可能是 64 位补码表示的负数，先转回有符号
  function toSigned(v) { return v >= 0x8000000000000000n ? v - 0x10000000000000000n : v; }
  var oLat = toSigned(latV), oLng = toSigned(lngV);
  if (oLat < -9000000000n || oLat > 9000000000n) return msgBytes;
  if (oLng < -18000000000n || oLng > 18000000000n) return msgBytes;
  var out = [];
  for (i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNo === 1 && f.wireType === 0) out.push(encodeField(1, 0, BigInt(Math.round(lat * SCALE))));
    else if (f.fieldNo === 2 && f.wireType === 0) out.push(encodeField(2, 0, BigInt(Math.round(lng * SCALE))));
    else if (f.fieldNo === 3 && f.wireType === 0) out.push(encodeField(3, 0, BigInt(acc)));
    else out.push(f.raw);
  }
  stats.replaced++;
  return concatBytes(out);
}

function transformSection(sectionBytes, entryFieldNo, lat, lng, acc, stats) {
  var fields = parseMessage(sectionBytes), i;
  var out = [];
  for (i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNo === entryFieldNo && f.wireType === 2) {
      out.push(encodeField(entryFieldNo, 2, replaceLocation(f.value, lat, lng, acc, stats)));
    } else out.push(f.raw);
  }
  return concatBytes(out);
}

function transformResponse(u8, lat, lng, acc) {
  var stats = { replaced: 0 }, i;
  var fields = parseMessage(u8);
  // 保真度检查：把解析出的原始字段拼回去，必须与输入逐字节一致。
  // 若不一致说明响应格式超出预期，直接透传，绝不输出可能损坏的数据。
  var raws = [];
  for (i = 0; i < fields.length; i++) raws.push(fields[i].raw);
  var rebuilt = concatBytes(raws);
  if (rebuilt.length !== u8.length) return { bytes: u8, replaced: 0 };
  for (i = 0; i < u8.length; i++) {
    if (rebuilt[i] !== u8[i]) return { bytes: u8, replaced: 0 };
  }
  var out = [];
  for (i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.wireType === 2 && f.fieldNo === 2) {
      // WiFi 区：内层 field 2 为 AP 条目
      out.push(encodeField(2, 2, transformSection(f.value, 2, lat, lng, acc, stats)));
    } else if (f.wireType === 2 && (f.fieldNo === 22 || f.fieldNo === 24)) {
      // 蜂窝区：内层 field 5 为基站条目
      out.push(encodeField(f.fieldNo, 2, transformSection(f.value, 5, lat, lng, acc, stats)));
    } else out.push(f.raw);
  }
  // 一个都没换掉则返回原始字节，确保零风险透传
  if (stats.replaced === 0) return { bytes: u8, replaced: 0 };
  return { bytes: concatBytes(out), replaced: stats.replaced };
}

// ---------- 参数读取（兼容多种 $argument 形态） ----------
function getArgs() {
  var raw = (typeof $argument !== 'undefined') ? $argument : null;
  var lng, lat, acc;
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.longitude !== undefined || raw.lng !== undefined) {
      return { lng: num(raw.longitude !== undefined ? raw.longitude : raw.lng),
               lat: num(raw.latitude !== undefined ? raw.latitude : raw.lat),
               acc: Math.round(num(raw.accuracy || raw.acc || 25, 25)) };
    }
  }
  if (Array.isArray(raw) && raw.length >= 2) {
    return { lng: num(raw[0]), lat: num(raw[1]), acc: Math.round(num(raw[2], 25)) };
  }
  if (typeof raw === 'string' && raw) {
    var m = raw.match(/\[([^\]]+)\]/);
    if (m) {
      var p = m[1].split(',');
      if (p.length >= 2) return { lng: num(p[0]), lat: num(p[1]), acc: Math.round(num(p[2], 25)) };
    }
    var kv = {};
    raw.split('&').forEach(function (s) { var i = s.indexOf('='); if (i > 0) kv[s.slice(0, i)] = s.slice(i + 1); });
    if (kv.longitude !== undefined) {
      return { lng: num(kv.longitude), lat: num(kv.latitude), acc: Math.round(num(kv.accuracy, 25)) };
    }
  }
  return null;
}

// 从设备持久化存储读取（地图选点页面"储存到设备"写入的）
function getPersistentArgs() {
  try {
    if (typeof $persistentStore === 'undefined') return null;
    var s = $persistentStore.read('virtual_location_settings');
    if (!s) return null;
    var o = JSON.parse(s);
    if (o && isFinite(o.lng) && isFinite(o.lat)) {
      return { lng: parseFloat(o.lng), lat: parseFloat(o.lat),
               acc: Math.round(parseFloat(o.acc) || 25) };
    }
  } catch (e) {}
  return null;
}

// ---------- 主入口 ----------
(function main() {
  var _origU8 = null; // 原始请求体字节，用于显式透传
  function doneEmpty() {
    try {
      if (_origU8) $done({ body: _origU8, bodyBytes: _origU8, rawBody: _origU8 });
      else $done();
    } catch (e) { try { $done(); } catch (e2) {} }
  }
  try {
    // 优先级：网站保存的坐标 > 插件参数
    var a = getPersistentArgs() || getArgs();
    // 透传模式：未设置有效坐标则不修改
    if (!a || !isFinite(a.lng) || !isFinite(a.lat)) { doneEmpty(); return; }
    if (Math.abs(a.lat) > 90 || Math.abs(a.lng) > 180) { doneEmpty(); return; }

    var body = ($response && ($response.bodyBytes || $response.rawBody || $response.body));
    var u8 = null;
    if (body instanceof ArrayBuffer) u8 = new Uint8Array(body);
    else if (body && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
      u8 = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } else if (typeof body === 'string' && body.length > 0) {
      u8 = new Uint8Array(body.length);
      for (var i = 0; i < body.length; i++) u8[i] = body.charCodeAt(i) & 0xFF;
    }
    if (!u8 || u8.length === 0) { doneEmpty(); return; }
    _origU8 = u8;

    var r = transformResponse(u8, a.lat, a.lng, a.acc);
    if (r.replaced === 0) { doneEmpty(); return; } // 没识别到定位条目，透传
    try { $notification.post('虚拟定位', '已替换 ' + r.replaced + ' 个定位条目', '目标: ' + a.lat + ',' + a.lng); } catch (e) {}
    // 返回修改后的二进制：删除 content-length/content-encoding 让 Loon 重算，避免长度不一致导致客户端解析失败
    var hdrs = {};
    try {
      var oh = $response.headers || {};
      for (var k in oh) {
        var lk = ('' + k).toLowerCase();
        if (lk === 'content-length' || lk === 'content-encoding') continue;
        hdrs[k] = oh[k];
      }
    } catch (e) {}
    $done({ headers: hdrs, body: r.bytes, bodyBytes: r.bytes, rawBody: r.bytes });
  } catch (e) {
    doneEmpty(); // 任何异常都透传，绝不破坏定位
  }
})();
