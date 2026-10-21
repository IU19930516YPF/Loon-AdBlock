// 不背单词 大会员/装备/酷币 本地改写 v1.0.3（2026-10-21，豆包维护）
// 依据用户真机抓包：权益由 learnywhere.cn 的 bb-user-category 接口下发，App 本地判定。
// - bb-user-category：9 个权益字段（bbvip + 8 个装备）全部改终身 VIP（不动 category 考试分类）
//   字段形状依据 App 自家 H5 代码：type 用 "svip"（终身档），到期字段是 expire_date（日期串），不是旧社区脚本的 expire_time
// - bbvip/purchase：购买页显示已购 + 酷币余额显示（服务器记账，真消费仍按真实余额校验）
// - coin-records：酷币明细页余额显示
// 其余响应原样放行；任何异常都原样放行，绝不弄坏 App。

const VIP = { type: "svip", expire_date: "2099-12-31", is_lifetime: 1, expire_time: 4102415999000, end_time: 4102415999000 };
const COIN = 999999;

// 手动运行/CRON 上下文没有 $request/$response：安静退出并留一句人话提示，不报错
if (typeof $request === "undefined" || typeof $response === "undefined") {
  console.log("[BBDanci] 这是 http-response 改写脚本，靠不背单词的请求触发，不要手动运行。判断是否生效：用完 App 后回日志列表找 Script Type 为 HTTP-RESPONSE 的本脚本记录。");
  $done({});
} else try {
  const url = ($request && $request.url) || "";
  let body = $response && $response.body;
  if (!body) { $done({}); }
  else {
    let obj = JSON.parse(body);
    let db = obj && obj.data_body;
    if (!db || typeof db !== "object") { $done({}); }
    else {
      let changed = false;

      // 1) 权益：data_body 里任何 *_vip / bbvip 字段一律终身 VIP
      for (const k of Object.keys(db)) {
        if (k === "bbvip" || /_vip$/.test(k)) {
          db[k] = Object.assign({}, VIP);
          changed = true;
        }
      }

      // 2) 购买页（bbvip/purchase、gear/purchase 通用）：所有 purchased 标志置 1 + 酷币余额显示
      if (/\/buy\/common\/bb\//.test(url)) {
        const markPurchased = (o) => {
          if (!o || typeof o !== "object") return;
          if (Array.isArray(o)) { o.forEach(markPurchased); return; }
          for (const k of Object.keys(o)) {
            if (k === "purchased") { o[k] = 1; changed = true; }
            else if (typeof o[k] === "object") markPurchased(o[k]);
          }
        };
        markPurchased(db);
        if (db.purchase && typeof db.purchase === "object") {
          if ("coin_remain" in db.purchase) db.purchase.coin_remain = COIN;
          if ("coin_available" in db.purchase) db.purchase.coin_available = COIN;
          if ("coin_shortage" in db.purchase) db.purchase.coin_shortage = 0;
          changed = true;
        }
      }

      // 3) 酷币明细页：余额显示
      if (/coin-records/.test(url) && "coin" in db) { db.coin = COIN; changed = true; }

      if (changed) {
        console.log("[BBDanci] rewritten: " + url.split("?")[0]);
        $done({ body: JSON.stringify(obj) });
      } else {
        $done({});
      }
    }
  }
} catch (e) {
  console.log("[BBDanci] error: " + e);
  $done({});
}
