/**
 * 4K影视（4kvm）本地改写 —— Loon http-response 脚本
 *
 * 基于 2026-10-21 真实抓包分析（www.4kvm.top）：
 *  - 个人中心 /profile：数据来自页面内嵌 PROFILE_INITIAL_DATA（balance/coin）
 *    与服务器渲染的会员徽章，改写后本地显示为 VIP + 大额余额/金币。
 *  - 播放页 /play/<id>：前贴广告由页面里的 data-preroll-ad-* 属性驱动
 *    （artplayer-ads 插件读取），清空这些属性即可跳过前贴广告；
 *    同时隐藏「成为会员享以下特权」黄色横幅。
 *
 * 能力边界（抓包实证，不是偷懒）：
 *  - 4K 画质拿不到：/video/play 接口由服务器按账号真实会员组下发地址，
 *    普通会员的 4K 档返回 locked:true、url:"1"（占位符），真实地址根本不下发，
 *    客户端改写变不出来。普通会员上限就是 1080p。
 *  - 假余额花不出去：兑换金币、开通会员等操作服务器会查真实余额/会员组，
 *    本地改的数字提交后会被服务器拒绝。这里只改显示。
 *
 * @Version：1.0.1（2026-10-21：手动运行/无请求上下文时安静退出，
 *   与 bbdanci v1.0.3 同款保护——此前手动点运行会 ReferenceError: $request）
 */

// 手动运行/CRON 上下文没有 $request/$response：安静退出并留一句人话提示，不报错
if (typeof $request === "undefined" || typeof $response === "undefined") {
    console.log("[4KTV] 这是 http-response 改写脚本，靠 4kvm 页面请求触发，不要手动运行。");
    $done({});
} else {
    const url = ($request && $request.url) || '';
    let body = $response && $response.body;

    if (!body) {
        $done({});
    } else if (/4kvm\.(?:top|site|net)\/profile(?:[?#]|$)/.test(url)) {
        // ===== 个人中心：显示改写 =====
        body = body
            // 内嵌数据（页面渲染与兑换弹窗都读它）
            .replace(/balance:\s*\d+(?:\.\d+)?/g, 'balance: 999999')
            .replace(/coin:\s*\d+(?:\.\d+)?/g, 'coin: 888888')
            // 会员徽章文案
            .replace(/>\s*普通会员\s*</g, '>永久VIP会员<')
            .replace(/>\s*标准用户\s*</g, '>尊贵VIP会员<')
            // 静态兜底显示（首屏未渲染 JS 前的占位数值）
            .replace(/>0\.00<\/span>/g, '>999999.00</span>')
            .replace(/>¥0<\/div>/g, '>¥999999</div>')
            .replace(/>0<\/span>\s*<span class="text-sm text-gray-500">枚金币/g,
                     '>888888</span><span class="text-sm text-gray-500">枚金币');
        $done({ body });
    } else if (/4kvm\.(?:top|site|net)\/play\//.test(url)) {
        // ===== 播放页：去前贴广告 + 隐藏会员横幅 =====
        body = body
            .replace(/data-preroll-ad-type="[^"]*"/g, 'data-preroll-ad-type=""')
            .replace(/data-preroll-ad-image="[^"]*"/g, 'data-preroll-ad-image=""')
            .replace(/data-preroll-ad-video="[^"]*"/g, 'data-preroll-ad-video=""')
            .replace(/data-preroll-ad-code="[^"]*"/g, 'data-preroll-ad-code=""')
            .replace(/data-preroll-ad-link="[^"]*"/g, 'data-preroll-ad-link=""')
            .replace(/data-preroll-ad-duration="[^"]*"/g, 'data-preroll-ad-duration="0"')
            .replace(/data-preroll-ad-skip-after="[^"]*"/g, 'data-preroll-ad-skip-after="0"')
            // 会员特权横幅（黄色渐变块）：不删结构，只隐藏，避免破坏页面布局脚本
            .replace('<div class="bg-gradient-to-r from-yellow-600 to-yellow-500 rounded-xl p-4">',
                     '<div class="bg-gradient-to-r from-yellow-600 to-yellow-500 rounded-xl p-4" style="display:none">');
        $done({ body });
    } else {
        $done({});
    }
}
