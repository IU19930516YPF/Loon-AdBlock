/*
 * X 去广告 v1.0.1（Loon http-response）
 * v1.0.1：插件侧匹配收窄到时间线类接口；脚本加安全网——摘除数超过候选条目一半
 *         （疑似结构变化/误匹配）时整份原样放行并打 [XAds] safety bail 日志。
 * 维护：豆包（入仓 IU19930516YPF/Loon-AdBlock，scripts-24h-maintain 巡检）
 *
 * 做什么：过滤 X 时间线响应里的两类内容——
 *  1) 推广推文（广告）：条目 content.itemContent 带 promotedMetadata 字段。
 *     字段依据（现行实证，非猜测）：
 *       - limbopro/Adblock4limbo 的 json-prune-xhr-response 现行规则，5 个面同字段：
 *         home.home_timeline_urt（主页）、search_timeline（搜索）、
 *         threaded_conversation_with_injections_v2（回复页，嵌套 content.items[].item）、
 *         user.result.timeline_v2（个人页）、immersiveMedia（沉浸媒体）
 *       - cantwork/Loon XAdsRemover.js 同样以 promotedMetadata 为判定。
 *  2) 推荐模块：entryId 前缀命中黑名单（who-to-follow 等）整条移除。
 *     前缀表按 X 时间线 URT 的 entryId 命名惯例拟定，移除明细全部打日志，
 *     待真机日志校准（误伤/漏网看 [XAds] 日志增删前缀）。
 *
 * 安全：仅过滤数组元素，不动游标（cursor-* 不在名单内）；任何异常原样放行；
 * 无 $response 上下文（手动运行）安静退出。
 */
(function () {
  var VERSION = "1.0.1";
  var TAG = "X去广告";

  if (typeof $response === "undefined" || !$response || typeof $response.body !== "string") {
    $done({});
    return;
  }

  var body = $response.body;
  // 快速预检：没有时间线结构直接放行，避免无谓解析
  if (body.indexOf("instructions") === -1 && body.indexOf("promotedMetadata") === -1) {
    $done({});
    return;
  }

  var obj;
  try {
    obj = JSON.parse(body);
  } catch (e) {
    $done({});
    return;
  }

  // 推荐模块 entryId 前缀黑名单（整条都是推荐/广告模块）
  var MODULE_PREFIXES = [
    "who-to-follow",
    "who-to-subscribe",
    "community-to-join",
    "community-to-subscribe",
    "connect-banner",
    "promoted"
  ];

  var removed = [];
  var candidates = 0; // 带 entryId 或 itemContent 的候选条目数（安全网的分母）

  function itemContentOf(el) {
    if (!el || typeof el !== "object") return null;
    if (el.content && el.content.itemContent) return el.content.itemContent;
    if (el.item && el.item.itemContent) return el.item.itemContent;
    if (el.itemContent) return el.itemContent;
    return null;
  }

  function isBadElement(el) {
    if (!el || typeof el !== "object") return false;
    // 推荐模块：按 entryId 前缀
    if (typeof el.entryId === "string") {
      for (var i = 0; i < MODULE_PREFIXES.length; i++) {
        if (el.entryId.indexOf(MODULE_PREFIXES[i]) === 0) return true;
      }
    }
    // 推广推文/推广内容：itemContent 带 promotedMetadata（精确路径，不深搜，避免误伤整串回复）
    var ic = itemContentOf(el);
    if (ic && ic.promotedMetadata) return true;
    return false;
  }

  function label(el) {
    if (el && typeof el.entryId === "string") return el.entryId;
    return "(item)";
  }

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      // 先过滤本层坏元素，再深入幸存者
      for (var i = node.length - 1; i >= 0; i--) {
        var el = node[i];
        if (el && typeof el === "object" && (typeof el.entryId === "string" || itemContentOf(el))) candidates++;
        if (isBadElement(el)) {
          removed.push(label(el));
          node.splice(i, 1);
        }
      }
      for (var j = 0; j < node.length; j++) walk(node[j]);
      return;
    }
    for (var k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k]);
    }
  }

  try {
    walk(obj);
  } catch (e) {
    console.log("[XAds] v" + VERSION + " walk error: " + e + " @" + TAG);
    $done({});
    return;
  }

  if (removed.length === 0) {
    $done({});
    return;
  }

  // 安全网：摘除比例异常（超过候选一半）说明结构和预期不符，整份原样放行
  if (candidates >= 4 && removed.length * 2 > candidates) {
    console.log("[XAds] v" + VERSION + " safety bail: removed " + removed.length + "/" + candidates + " candidates, passthrough");
    $done({});
    return;
  }

  console.log("[XAds] v" + VERSION + " removed " + removed.length + ": " + removed.join(", "));
  $done({ body: JSON.stringify(obj) });
})();
