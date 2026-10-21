/*
@Name：PingMe 自动化签到+视频奖励（优化版）
@Version：1.2.1（2026-10-21，修复同账号重复识别 + 只保留最近 2 个账号）
@Repo：https://github.com/IU19930516YPF/Loon-AdBlock（script/PingMeSignin.js）
@Author：原版 fmz200/奶思（基于 ZenmoFeiShi 版）；优化维护：豆包
@优化点：
  1. 每个请求显式 30 秒超时 + 最多 3 次重试（间隔 3s/6s 递增）——原版无超时无重试，
     Loon 默认约 5 秒超时，节点一抖第一个请求就整单失败（2026-10-21 实测 5.542 秒超时失败）。
  2. 抓参并入同一脚本：http-request 模式自动存参，不再依赖 get_cookie.js，
     参数每次打开 App 自动刷新、不过期。
  3. 多账号（v1.2.0）：抓参按账号标识去重存成列表，双开两个 PingMe 各打开一次即存下两个账号；
     cron 挨个账号签到+视频奖励，最后合并一条通知（单账号参数 pingme_capture_v3 继续兼容）。
  4. 修复原版早退 bug：参数缺失/损坏时通知后直接终止，不再继续执行二次报错。
  5. 参数失效（retcode!=0）在第一步就识别，合并通知里单独标注该账号请重新打开 App 抓参，不影响其他账号。
  6. 通知带每步结果 + 本次收益（最新余额与运行前余额差值）。

============Loon 插件============
订阅本插件后：每个 PingMe 账号各打开 App 一次即自动抓参；cron 每天 08:30、20:30 自动全部签到。
[MITM] hostname = api.pingmeapp.net
*/

const $ = new Env('PingMe签到');
const isNode = $.isNode();
// 原版这里直接 require，路径不对就整脚本崩溃；改成容错加载，失败时通知降级为日志
const notify = (() => { try { return isNode ? require('../qinglong/sendNotify') : ''; } catch (e) { return ''; } })();
$.nodeNotifyMsg = []; // nodeJS合并通知（保留原版变量）

const ckKey = 'pingme_capture_v3';      // 最新一次抓到的参数（兼容原版单账号）
const ckListKey = 'pingme_accounts_v1'; // 多账号参数列表（v1.2.0 新增）
const SECRET = '0fOiukQq7jXZV2GRi9LGlO';
const MAX_VIDEO = 5;
const VIDEO_DELAY = 8000;
const REQ_TIMEOUT_MS = 30000; // 单次请求超时 30 秒（原版未设，吃 Loon 默认 ~5 秒）
const MAX_RETRY = 3;          // 每个请求最多尝试 3 次
const RETRY_DELAY = 3000;     // 重试间隔基数（第 n 次重试前等待 3n 秒）
// 易变参数（每次请求都变，如 time/nonce/sign，不能用来认账号——v1.2.0 就是栽在这上面，同一账号被存了两份）
const VOLATILE_RE = /sign|time|stamp|nonce|rand|trace|seq|session/i;
const UID_KEYS = ['uid', 'userId', 'user_id', 'userid', 'userID', 'memberId', 'member_id', 'accountId', 'account_id'];
const TOKEN_HEADERS = ['authorization', 'token', 'x-token', 'access-token', 'accesstoken', 'user-token', 'auth-token'];
const MAX_ACCOUNTS = 2; // 用户只有两个 PingMe 账号，只保留最近抓到的两个

const isRequestMode = (typeof $request !== 'undefined' && !!$request && !!$request.url);

if (isRequestMode) {
    captureParams();
} else {
    startTasks()
        .then(() => $.done())
        .catch(e => { console.log('未捕获异常：' + (e && e.stack ? e.stack : e)); $.done(); });
}

function headerVal(headers, name) {
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers || {})) if (k.toLowerCase() === lower) return headers[k];
    return '';
}

// 账号标识：uid 类参数 → 令牌类请求头 → 去掉易变参数后的稳定签名
function accountIdOf(capture) {
    const p = (capture && capture.paramsRaw) || {};
    const h = (capture && capture.headers) || {};
    for (const k of UID_KEYS) if (p[k]) return 'uid:' + p[k];
    for (const name of TOKEN_HEADERS) { const v = headerVal(h, name); if (v) return 'auth:' + v; }
    const rest = Object.keys(p).filter(k => !VOLATILE_RE.test(k)).sort().map(k => `${k}=${p[k]}`).join('&');
    return 'raw:' + MD5(rest);
}

// 按账号标识去重（后出现的覆盖先出现的）+ 只保留最近 MAX_ACCOUNTS 个
function dedupeAccounts(list) {
    const seen = new Map();
    for (const c of list) { if (c && c.paramsRaw) seen.set(accountIdOf(c), c); }
    let out = Array.from(seen.values());
    if (out.length > MAX_ACCOUNTS) out = out.slice(out.length - MAX_ACCOUNTS);
    return out;
}

function accountLabel(id) {
    if (id.indexOf('uid:') === 0) return 'uid ' + id.slice(4);
    if (id.indexOf('auth:') === 0) return '授权 …' + id.slice(-4);
    return '账号 …' + id.slice(-4);
}

function loadAccounts() {
    let list = [];
    try { list = JSON.parse($.getdata(ckListKey) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    list = list.filter(c => c && c.paramsRaw);
    if (!list.length) {
        // 兼容原版单账号参数（老用户已抓的那一份）
        const raw = isNode ? process.env[ckKey] : $.getdata(ckKey);
        if (raw) {
            try {
                const one = JSON.parse(raw);
                if (one && one.paramsRaw) list = [one];
            } catch (e) { /* 参数损坏，返回空列表 */ }
        }
    }
    // 自愈：合并同账号重复项 + 只留最近 2 个，变化了就写回存量
    const cleaned = dedupeAccounts(list);
    if (cleaned.length !== list.length) {
        saveAccounts(cleaned);
        console.log(`账号列表已清理：${list.length} → ${cleaned.length} 个`);
    }
    return cleaned;
}

function saveAccounts(list) {
    $.setdata(JSON.stringify(list), ckListKey);
}

// http-request 模式：抓取并保存签到参数（按账号去重，多账号共存）
function captureParams() {
    try {
        const capture = {
            url: $request.url,
            paramsRaw: parseRawQuery($request.url),
            headers: normalizeHeaderNameMap($request.headers || {})
        };
        const id = accountIdOf(capture);
        let list = loadAccounts().filter(c => accountIdOf(c) !== id);
        list.push(capture); // 移到末尾 = 最近抓到，配合 MAX_ACCOUNTS 保留策略
        list = dedupeAccounts(list);
        saveAccounts(list);
        $.setdata(JSON.stringify(capture), ckKey); // 保持最新一份兼容
        $.msg($.name, '✅ 参数获取成功', `账号 ${accountLabel(id)} 已保存，当前共 ${list.length} 个账号`);
        console.log(`PingMe 参数已更新：${id}，共 ${list.length} 个账号`);
    } catch (e) {
        console.log('PingMe 抓参失败：' + e);
    }
    $.done({});
}

async function startTasks() {
    console.log("开始运行签到");
    const accounts = loadAccounts();
    if (!accounts.length) {
        await sendMsg('❌ 未抓到参数', '请先打开 PingMe App 触发一次（插件会自动抓参）；双开的两个账号要各打开一次');
        return;
    }
    console.log(`共 ${accounts.length} 个账号，逐个执行`);

    const sections = [];
    let okCount = 0;
    for (let i = 0; i < accounts.length; i++) {
        const capture = accounts[i];
        const label = `账号${i + 1}（${accountLabel(accountIdOf(capture))}）`;
        const r = await runOneAccount(capture);
        if (r.ok) okCount++;
        sections.push(`—— ${label} ——\n` + r.lines.join('\n'));
        if (i < accounts.length - 1) await $.wait(2000);
    }

    const title = okCount === accounts.length ? `🎉 任务完成（${accounts.length} 个账号）` : `⚠️ 部分完成（${okCount}/${accounts.length} 个账号）`;
    await sendMsg(title, sections.join('\n\n'));
}

// 单个账号的完整流程，返回 {ok, lines}
async function runOneAccount(capture) {
    console.log("组装请求头");
    const headers = buildHeaders(capture);

    // 带超时+重试的请求：网络错误/超时/非 JSON 响应才重试；业务 retcode 判断在外层、不重试
    async function fetchApi(path, label) {
        let lastErr = '';
        for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
            try {
                const res = await $.http.get({ url: buildUrl(path, capture), headers: headers, timeout: REQ_TIMEOUT_MS });
                return JSON.parse(res.body);
            } catch (e) {
                lastErr = (e && (e.error || e.message)) || String(e) || '请求失败';
                console.log(`${label} 第 ${attempt}/${MAX_RETRY} 次失败：${lastErr}`);
                if (attempt < MAX_RETRY) await $.wait(RETRY_DELAY * attempt);
            }
        }
        throw new Error(`${label}失败（已重试 ${MAX_RETRY} 次）：${lastErr}`);
    }

    const lines = [];

    // 1. 查询运行前余额 + 校验参数有效性
    let before = null;
    try {
        const d = await fetchApi('queryBalanceAndBonus', '查询余额');
        if (d.retcode === 0) {
            before = d.result.balance;
            lines.push(`💰 运行前余额：${before} Coins`);
        } else {
            lines.push(`❌ 参数可能已失效：${d.retmsg || ('retcode=' + d.retcode)}，请打开该账号的 PingMe 重新抓参`);
            return { ok: false, lines };
        }
    } catch (e) {
        lines.push(`❌ ${e.message}`);
        return { ok: false, lines };
    }

    // 2. 签到
    try {
        const d = await fetchApi('checkIn', '签到');
        if (d.retcode === 0) lines.push(`✅ 签到：${(d.result?.bonusHint || d.retmsg || '成功').replace(/\n/g, ' ')}`);
        else lines.push(`⚠️ 签到：${d.retmsg || ('retcode=' + d.retcode)}`);
    } catch (e) {
        lines.push(`❌ ${e.message}`);
    }

    // 3. 视频奖励（业务返回不可用即停；单个网络失败不影响后续统计）
    for (let i = 1; i <= MAX_VIDEO; i++) {
        await $.wait(i === 1 ? 1500 : VIDEO_DELAY);
        try {
            const d = await fetchApi('videoBonus', `视频${i}`);
            if (d.retcode === 0) {
                lines.push(`🎬 视频${i}：+${(d.result && d.result.bonus != null) ? d.result.bonus : '?'} Coins`);
            } else {
                lines.push(`⏸ 视频${i}：${d.retmsg || ('retcode=' + d.retcode)}`);
                break;
            }
        } catch (e) {
            lines.push(`❌ ${e.message}`);
        }
    }

    // 4. 查询最新余额 + 汇总本次收益
    try {
        const d = await fetchApi('queryBalanceAndBonus', '查询最新余额');
        if (d.retcode === 0) {
            lines.unshift(`💰 最新余额：${d.result.balance} Coins`);
            const b0 = Number(before), b1 = Number(d.result.balance);
            if (before !== null && isFinite(b0) && isFinite(b1) && b1 !== b0) {
                const gain = Math.round((b1 - b0) * 100) / 100;
                lines.splice(1, 0, `📈 本次收益：${gain > 0 ? '+' : ''}${gain} Coins`);
            }
        }
    } catch (e) {
        console.log('查询最新余额失败：' + e.message);
    }

    return { ok: true, lines };
}

async function sendMsg(titleSuffix, desc) {
    if (isNode && notify && notify.sendNotify) {
        await notify.sendNotify($.name + titleSuffix, desc).then(r => console.log("通知发送完成"));
    } else if (isNode) {
        console.log($.name + titleSuffix + '\n' + desc);
    } else {
        $.msg($.name + titleSuffix, '', desc, {
            'media-url': 'https://uaena.107-174-92-178.nip.io:1443/pingme-checkin/PingMe.png'
        });
    }
}

function MD5(string) {
    function RotateLeft(lValue, iShiftBits) { return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits)); }
    function AddUnsigned(lX, lY) {
        const lX4 = lX & 0x40000000, lY4 = lY & 0x40000000, lX8 = lX & 0x80000000, lY8 = lY & 0x80000000;
        const lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
        if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
        if (lX4 | lY4) return (lResult & 0x40000000) ? (lResult ^ 0xC0000000 ^ lX8 ^ lY8) : (lResult ^ 0x40000000 ^ lX8 ^ lY8);
        return lResult ^ lX8 ^ lY8;
    }
    function F(x, y, z) { return (x & y) | ((~x) & z); }
    function G(x, y, z) { return (x & z) | (y & (~z)); }
    function H(x, y, z) { return x ^ y ^ z; }
    function I(x, y, z) { return y ^ (x | (~z)); }
    function FF(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(F(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
    function GG(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(G(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
    function HH(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(H(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
    function II(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(I(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
    function ConvertToWordArray(str) {
        const lMessageLength = str.length;
        const lNumberOfWords_temp1 = lMessageLength + 8;
        const lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
        const lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
        const lWordArray = Array(lNumberOfWords - 1).fill(0);
        let lBytePosition = 0, lByteCount = 0;
        while (lByteCount < lMessageLength) {
            const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
            lBytePosition = (lByteCount % 4) * 8;
            lWordArray[lWordCount] |= str.charCodeAt(lByteCount) << lBytePosition;
            lByteCount++;
        }
        const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
        lBytePosition = (lByteCount % 4) * 8;
        lWordArray[lWordCount] |= 0x80 << lBytePosition;
        lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
        lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
        return lWordArray;
    }
    function WordToHex(lValue) {
        let WordToHexValue = '';
        for (let lCount = 0; lCount <= 3; lCount++) {
            const lByte = (lValue >>> (lCount * 8)) & 255;
            const WordToHexValue_temp = '0' + lByte.toString(16);
            WordToHexValue += WordToHexValue_temp.substr(WordToHexValue_temp.length - 2, 2);
        }
        return WordToHexValue;
    }
    const x = ConvertToWordArray(string);
    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    const S11 = 7, S12 = 12, S13 = 17, S14 = 22, S21 = 5, S22 = 9, S23 = 14, S24 = 20;
    const S31 = 4, S32 = 11, S33 = 16, S34 = 23, S41 = 6, S42 = 10, S43 = 15, S44 = 21;
    for (let k = 0; k < x.length; k += 16) {
        const AA = a, BB = b, CC = c, DD = d;
        a = FF(a,b,c,d,x[k+0],S11,0xD76AA478); d = FF(d,a,b,c,x[k+1],S12,0xE8C7B756); c = FF(c,d,a,b,x[k+2],S13,0x242070DB); b = FF(b,c,d,a,x[k+3],S14,0xC1BDCEEE);
        a = FF(a,b,c,d,x[k+4],S11,0xF57C0FAF); d = FF(d,a,b,c,x[k+5],S12,0x4787C62A); c = FF(c,d,a,b,x[k+6],S13,0xA8304613); b = FF(b,c,d,a,x[k+7],S14,0xFD469501);
        a = FF(a,b,c,d,x[k+8],S11,0x698098D8); d = FF(d,a,b,c,x[k+9],S12,0x8B44F7AF); c = FF(c,d,a,b,x[k+10],S13,0xFFFF5BB1); b = FF(b,c,d,a,x[k+11],S14,0x895CD7BE);
        a = FF(a,b,c,d,x[k+12],S11,0x6B901122); d = FF(d,a,b,c,x[k+13],S12,0xFD987193); c = FF(c,d,a,b,x[k+14],S13,0xA679438E); b = FF(b,c,d,a,x[k+15],S14,0x49B40821);
        a = GG(a,b,c,d,x[k+1],S21,0xF61E2562); d = GG(d,a,b,c,x[k+6],S22,0xC040B340); c = GG(c,d,a,b,x[k+11],S23,0x265E5A51); b = GG(b,c,d,a,x[k+0],S24,0xE9B6C7AA);
        a = GG(a,b,c,d,x[k+5],S21,0xD62F105D); d = GG(d,a,b,c,x[k+10],S22,0x02441453); c = GG(c,d,a,b,x[k+15],S23,0xD8A1E681); b = GG(b,c,d,a,x[k+4],S24,0xE7D3FBC8);
        a = GG(a,b,c,d,x[k+9],S21,0x21E1CDE6); d = GG(d,a,b,c,x[k+14],S22,0xC33707D6); c = GG(c,d,a,b,x[k+3],S23,0xF4D50D87); b = GG(b,c,d,a,x[k+8],S24,0x455A14ED);
        a = GG(a,b,c,d,x[k+13],S21,0xA9E3E905); d = GG(d,a,b,c,x[k+2],S22,0xFCEFA3F8); c = GG(c,d,a,b,x[k+7],S23,0x676F02D9); b = GG(b,c,d,a,x[k+12],S24,0x8D2A4C8A);
        a = HH(a,b,c,d,x[k+5],S31,0xFFFA3942); d = HH(d,a,b,c,x[k+8],S32,0x8771F681); c = HH(c,d,a,b,x[k+11],S33,0x6D9D6122); b = HH(b,c,d,a,x[k+14],S34,0xFDE5380C);
        a = HH(a,b,c,d,x[k+1],S31,0xA4BEEA44); d = HH(d,a,b,c,x[k+4],S32,0x4BDECFA9); c = HH(c,d,a,b,x[k+7],S33,0xF6BB4B60); b = HH(b,c,d,a,x[k+10],S34,0xBEBFBC70);
        a = HH(a,b,c,d,x[k+13],S31,0x289B7EC6); d = HH(d,a,b,c,x[k+0],S32,0xEAA127FA); c = HH(c,d,a,b,x[k+3],S33,0xD4EF3085); b = HH(b,c,d,a,x[k+6],S34,0x04881D05);
        a = HH(a,b,c,d,x[k+9],S31,0xD9D4D039); d = HH(d,a,b,c,x[k+12],S32,0xE6DB99E5); c = HH(c,d,a,b,x[k+15],S33,0x1FA27CF8); b = HH(b,c,d,a,x[k+2],S34,0xC4AC5665);
        a = II(a,b,c,d,x[k+0],S41,0xF4292244); d = II(d,a,b,c,x[k+7],S42,0x432AFF97); c = II(c,d,a,b,x[k+14],S43,0xAB9423A7); b = II(b,c,d,a,x[k+5],S44,0xFC93A039);
        a = II(a,b,c,d,x[k+12],S41,0x655B59C3); d = II(d,a,b,c,x[k+3],S42,0x8F0CCC92); c = II(c,d,a,b,x[k+10],S43,0xFFEFF47D); b = II(b,c,d,a,x[k+1],S44,0x85845DD1);
        a = II(a,b,c,d,x[k+8],S41,0x6FA87E4F); d = II(d,a,b,c,x[k+15],S42,0xFE2CE6E0); c = II(c,d,a,b,x[k+6],S43,0xA3014314); b = II(b,c,d,a,x[k+13],S44,0x4E0811A1);
        a = II(a,b,c,d,x[k+4],S41,0xF7537E82); d = II(d,a,b,c,x[k+11],S42,0xBD3AF235); c = II(c,d,a,b,x[k+2],S43,0x2AD7D2BB); b = II(b,c,d,a,x[k+9],S44,0xEB86D391);
        a = AddUnsigned(a,AA); b = AddUnsigned(b,BB); c = AddUnsigned(c,CC); d = AddUnsigned(d,DD);
    }
    return (WordToHex(a) + WordToHex(b) + WordToHex(c) + WordToHex(d)).toLowerCase();
}

function getUTCSignDate() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
}

function normalizeHeaderNameMap(headers) {
    const out = {};
    Object.keys(headers || {}).forEach(k => out[k] = headers[k]);
    return out;
}

function parseRawQuery(url) {
    const query = (url.split('?')[1] || '').split('#')[0];
    const rawMap = {};
    query.split('&').forEach(pair => {
        if (!pair) return;
        const idx = pair.indexOf('=');
        if (idx < 0) return;
        const k = pair.slice(0, idx);
        const v = pair.slice(idx + 1);
        rawMap[k] = v;
    });
    return rawMap;
}

function buildSignedParamsRaw(capture) {
    const params = {};
    Object.keys(capture.paramsRaw || {}).forEach(k => {
        if (k !== 'sign' && k !== 'signDate') params[k] = capture.paramsRaw[k];
    });
    params.signDate = getUTCSignDate();
    const signBase = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    params.sign = MD5(signBase + SECRET);
    return params;
}

function buildUrl(path, capture) {
    const params = buildSignedParamsRaw(capture);
    const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    return `https://api.pingmeapp.net/app/${path}?${qs}`;
}

function cloneHeaders(headers) {
    const out = {};
    Object.keys(headers || {}).forEach(k => out[k] = headers[k]);
    return out;
}

function buildHeaders(capture) {
    const headers = cloneHeaders(capture.headers || {});
    delete headers['Content-Length']; delete headers['content-length'];
    delete headers[':authority']; delete headers[':method']; delete headers[':path']; delete headers[':scheme'];
    headers['Host'] = 'api.pingmeapp.net';
    headers['Accept'] = headers['Accept'] || 'application/json';
    return headers;
}

// Env 框架（原版保留）
function Env(t,e){class s{constructor(t){this.env=t}send(t,e="GET"){t="string"==typeof t?{url:t}:t;let s=this.get;"POST"===e&&(s=this.post);const i=new Promise(((e,i)=>{s.call(this,t,((t,s,o)=>{t?i(t):e(s)}))}));return t.timeout?((t,e=1e3)=>Promise.race([t,new Promise(((t,s)=>{setTimeout((()=>{s(new Error("请求超时"))}),e)}))]))(i,t.timeout):i}get(t){return this.send.call(this.env,t)}post(t){return this.send.call(this.env,t,"POST")}}return new class{constructor(t,e){this.logLevels={debug:0,info:1,warn:2,error:3},this.logLevelPrefixs={debug:"[DEBUG] ",info:"[INFO] ",warn:"[WARN] ",error:"[ERROR] "},this.logLevel="info",this.name=t,this.http=new s(this),this.data=null,this.dataFile="box.dat",this.logs=[],this.isMute=!1,this.isNeedRewrite=!1,this.logSeparator="\n",this.encoding="utf-8",this.startTime=(new Date).getTime(),Object.assign(this,e),this.log("",`🔔${this.name}, 开始!`)}getEnv(){return"undefined"!=typeof $environment&&$environment["surge-version"]?"Surge":"undefined"!=typeof $environment&&$environment["stash-version"]?"Stash":"undefined"!=typeof module&&module.exports?"Node.js":"undefined"!=typeof $task?"Quantumult X":"undefined"!=typeof $loon?"Loon":"undefined"!=typeof $rocket?"Shadowrocket":void 0}isNode(){return"Node.js"===this.getEnv()}isQuanX(){return"Quantumult X"===this.getEnv()}isSurge(){return"Surge"===this.getEnv()}isLoon(){return"Loon"===this.getEnv()}isShadowrocket(){return"Shadowrocket"===this.getEnv()}isStash(){return"Stash"===this.getEnv()}toObj(t,e=null){try{return JSON.parse(t)}catch{return e}}toStr(t,e=null,...s){try{return JSON.stringify(t,...s)}catch{return e}}getjson(t,e){let s=e;if(this.getdata(t))try{s=JSON.parse(this.getdata(t))}catch{}return s}setjson(t,e){try{return this.setdata(JSON.stringify(t),e)}catch{return!1}}getScript(t){return new Promise((e=>{this.get({url:t},((t,s,i)=>e(i)))}))}runScript(t,e){return new Promise((s=>{let i=this.getdata("@chavy_boxjs_userCfgs.httpapi");i=i?i.replace(/\n/g,"").trim():i;let o=this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");o=o?1*o:20,o=e&&e.timeout?e.timeout:o;const[r,a]=i.split("@"),n={url:`http://${a}/v1/scripting/evaluate`,body:{script_text:t,mock_type:"cron",timeout:o},headers:{"X-Key":r,Accept:"*/*"},policy:"DIRECT",timeout:o};this.post(n,((t,e,i)=>s(i)))})).catch((t=>this.logErr(t)))}loaddata(){if(!this.isNode())return{};{this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e);if(!s&&!i)return{};{const i=s?t:e;try{return JSON.parse(this.fs.readFileSync(i))}catch(t){return{}}}}}writedata(){if(this.isNode()){this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e),o=JSON.stringify(this.data);s?this.fs.writeFileSync(t,o):i?this.fs.writeFileSync(e,o):this.fs.writeFileSync(t,o)}}lodash_get(t,e,s){const i=e.replace(/\[(\d+)\]/g,".$1").split(".");let o=t;for(const t of i)if(o=Object(o)[t],void 0===o)return s;return o}lodash_set(t,e,s){return Object(t)!==t||(Array.isArray(e)||(e=e.toString().match(/[^.[\]]+/g)||[]),e.slice(0,-1).reduce(((t,s,i)=>Object(t[s])===t[s]?t[s]:t[s]=Math.abs(e[i+1])>>0==+e[i+1]?[]:{}),t)[e[e.length-1]]=s),t}getdata(t){let e=this.getval(t);if(/^@/.test(t)){const[,s,i]=/^@(.*?)\.(.*?)$/.exec(t),o=s?this.getval(s):"";if(o)try{const t=JSON.parse(o);e=t?this.lodash_get(t,i,""):e}catch(t){e=""}}return e}setdata(t,e){let s=!1;if(/^@/.test(e)){const[,i,o]=/^@(.*?)\.(.*?)$/.exec(e),r=this.getval(i),a=i?"null"===r?null:r||"{}":"{}";try{const e=JSON.parse(a);this.lodash_set(e,o,t),s=this.setval(JSON.stringify(e),i)}catch(e){const r={};this.lodash_set(r,o,t),s=this.setval(JSON.stringify(r),i)}}else s=this.setval(t,e);return s}getval(t){switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":return $persistentStore.read(t);case"Quantumult X":return $prefs.valueForKey(t);case"Node.js":return this.data=this.loaddata(),this.data[t];default:return this.data&&this.data[t]||null}}setval(t,e){switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":return $persistentStore.write(t,e);case"Quantumult X":return $prefs.setValueForKey(t,e);case"Node.js":return this.data=this.loaddata(),this.data[e]=t,this.writedata(),!0;default:return this.data&&this.data[e]||null}}initGotEnv(t){this.got=this.got?this.got:require("got"),this.cktough=this.cktough?this.cktough:require("tough-cookie"),this.ckjar=this.ckjar?this.ckjar:new this.cktough.CookieJar,t&&(t.headers=t.headers?t.headers:{},t&&(t.headers=t.headers?t.headers:{},void 0===t.headers.cookie&&void 0===t.headers.Cookie&&void 0===t.cookieJar&&(t.cookieJar=this.ckjar)))}get(t,e=(()=>{})){switch(t.headers&&(delete t.headers["Content-Type"],delete t.headers["Content-Length"],delete t.headers["content-type"],delete t.headers["content-length"]),t.params&&(t.url+="?"+this.queryStr(t.params)),void 0===t.followRedirect||t.followRedirect||((this.isSurge()||this.isLoon())&&(t["auto-redirect"]=!1),this.isQuanX()&&(t.opts?t.opts.redirection=!1:t.opts={redirection:!1})),this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":default:this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.get(t,((t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status?s.status:s.statusCode,s.status=s.statusCode),e(t,s,i)}));break;case"Quantumult X":this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then((t=>{const{statusCode:s,statusCode:i,headers:o,body:r,bodyBytes:a}=t;e(null,{status:s,statusCode:i,headers:o,body:r,bodyBytes:a},r,a)}),(t=>e(t&&t.error||"UndefinedError")));break;case"Node.js":let s=require("iconv-lite");this.initGotEnv(t),this.got(t).on("redirect",((t,e)=>{try{if(t.headers["set-cookie"]){const s=t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();s&&this.ckjar.setCookieSync(s,null),e.cookieJar=this.ckjar}}catch(t){this.logErr(t)}})).then((t=>{const{statusCode:i,statusCode:o,headers:r,rawBody:a}=t,n=s.decode(a,this.encoding);e(null,{status:i,statusCode:o,headers:r,rawBody:a,body:n},n)}),(t=>{const{message:i,response:o}=t;e(i,o,o&&s.decode(o.rawBody,this.encoding))}));break}}post(t,e=(()=>{})){const s=t.method?t.method.toLocaleLowerCase():"post";switch(t.body&&t.headers&&!t.headers["Content-Type"]&&!t.headers["content-type"]&&(t.headers["content-type"]="application/x-www-form-urlencoded"),t.headers&&(delete t.headers["Content-Length"],delete t.headers["content-length"]),void 0===t.followRedirect||t.followRedirect||((this.isSurge()||this.isLoon())&&(t["auto-redirect"]=!1),this.isQuanX()&&(t.opts?t.opts.redirection=!1:t.opts={redirection:!1})),this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":default:this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient[s](t,((t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status?s.status:s.statusCode,s.status=s.statusCode),e(t,s,i)}));break;case"Quantumult X":t.method=s,this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then((t=>{const{statusCode:s,statusCode:i,headers:o,body:r,bodyBytes:a}=t;e(null,{status:s,statusCode:i,headers:o,body:r,bodyBytes:a},r,a)}),(t=>e(t&&t.error||"UndefinedError")));break;case"Node.js":let i=require("iconv-lite");this.initGotEnv(t);const{url:o,...r}=t;this.got[s](o,r).then((t=>{const{statusCode:s,statusCode:o,headers:r,rawBody:a}=t,n=i.decode(a,this.encoding);e(null,{status:s,statusCode:o,headers:r,rawBody:a,body:n},n)}),(t=>{const{message:s,response:o}=t;e(s,o,o&&i.decode(o.rawBody,this.encoding))}));break}}time(t,e=null){const s=e?new Date(e):new Date;let i={"M+":s.getMonth()+1,"d+":s.getDate(),"H+":s.getHours(),"m+":s.getMinutes(),"s+":s.getSeconds(),"q+":Math.floor((s.getMonth()+3)/3),S:s.getMilliseconds()};/(y+)/.test(t)&&(t=t.replace(RegExp.$1,(s.getFullYear()+"").substr(4-RegExp.$1.length)));for(let e in i)new RegExp("("+e+")").test(t)&&(t=t.replace(RegExp.$1,1==RegExp.$1.length?i[e]:("00"+i[e]).substr((""+i[e]).length)));return t}queryStr(t){let e="";for(const s in t){let i=t[s];null!=i&&""!==i&&("object"==typeof i&&(i=JSON.stringify(i)),e+=`${s}=${i}&`)}return e=e.substring(0,e.length-1),e}msg(e=t,s="",i="",o={}){const r=t=>{const{$open:e,$copy:s,$media:i,$mediaMime:o}=t;switch(typeof t){case void 0:return t;case"string":switch(this.getEnv()){case"Surge":case"Stash":default:return{url:t};case"Loon":case"Shadowrocket":return t;case"Quantumult X":return{"open-url":t};case"Node.js":return}case"object":switch(this.getEnv()){case"Surge":case"Stash":case"Shadowrocket":default:{const r={};let a=t.openUrl||t.url||t["open-url"]||e;a&&Object.assign(r,{action:"open-url",url:a});let n=t["update-pasteboard"]||t.updatePasteboard||s;if(n&&Object.assign(r,{action:"clipboard",text:n}),i){let t,e,s;if(i.startsWith("http"))t=i;else if(i.startsWith("data:")){const[t]=i.split(";"),[,o]=i.split(",");e=o,s=t.replace("data:","")}else{e=i,s=(t=>{const e={JVBERi0:"application/pdf",R0lGODdh:"image/gif",R0lGODlh:"image/gif",iVBORw0KGgo:"image/png","/9j/":"image/jpg"};for(var s in e)if(0===t.indexOf(s))return e[s];return null})(i)}Object.assign(r,{"media-url":t,"media-base64":e,"media-base64-mime":o??s})}return Object.assign(r,{"auto-dismiss":t["auto-dismiss"],sound:t.sound}),r}case"Loon":{const s={};let o=t.openUrl||t.url||t["open-url"]||e;o&&Object.assign(s,{openUrl:o});let r=t.mediaUrl||t["media-url"];return i?.startsWith("http")&&(r=i),r&&Object.assign(s,{mediaUrl:r}),console.log(JSON.stringify(s)),s}case"Quantumult X":{const o={};let r=t["open-url"]||t.url||t.openUrl||e;r&&Object.assign(o,{"open-url":r});let a=t["media-url"]||t.mediaUrl;i?.startsWith("http")&&(a=i),a&&Object.assign(o,{"media-url":a});let n=t["update-pasteboard"]||t.updatePasteboard||s;return n&&Object.assign(o,{"update-pasteboard":n}),console.log(JSON.stringify(o)),o}case"Node.js":return}default:return}};if(!this.isMute)switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":default:$notification.post(e,s,i,r(o));break;case"Quantumult X":$notify(e,s,i,r(o));break;case"Node.js":break}if(!this.isMuteLog){let t=["","==============📣系统通知📣=============="];t.push(e),s&&t.push(s),i&&t.push(i),console.log(t.join("\n")),this.logs=this.logs.concat(t)}}debug(...t){this.logLevels[this.logLevel]<=this.logLevels.debug&&(t.length>0&&(this.logs=[...this.logs,...t]),console.log(`${this.logLevelPrefixs.debug}${t.map((t=>t??String(t))).join(this.logSeparator)}`))}info(...t){this.logLevels[this.logLevel]<=this.logLevels.info&&(t.length>0&&(this.logs=[...this.logs,...t]),console.log(`${this.logLevelPrefixs.info}${t.map((t=>t??String(t))).join(this.logSeparator)}`))}warn(...t){this.logLevels[this.logLevel]<=this.logLevels.warn&&(t.length>0&&(this.logs=[...this.logs,...t]),console.log(`${this.logLevelPrefixs.warn}${t.map((t=>t??String(t))).join(this.logSeparator)}`))}error(...t){this.logLevels[this.logLevel]<=this.logLevels.error&&(t.length>0&&(this.logs=[...this.logs,...t]),console.log(`${this.logLevelPrefixs.error}${t.map((t=>t??String(t))).join(this.logSeparator)}`))}log(...t){t.length>0&&(this.logs=[...this.logs,...t]),console.log(t.map((t=>t??String(t))).join(this.logSeparator))}logErr(t,e){switch(this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":case"Quantumult X":default:this.log("",`❗️${this.name}, 错误!`,e,t);break;case"Node.js":this.log("",`❗️${this.name}, 错误!`,e,void 0!==t.message?t.message:t,t.stack);break}}wait(t){return new Promise((e=>setTimeout(e,t)))}done(t={}){const e=((new Date).getTime()-this.startTime)/1e3;switch(this.log("",`🔔${this.name}, 结束! 🕛 ${e} 秒`),this.log(),this.getEnv()){case"Surge":case"Loon":case"Stash":case"Shadowrocket":case"Quantumult X":default:$done(t);break;case"Node.js":process.exit(1)}}}(t,e)}
// API end
