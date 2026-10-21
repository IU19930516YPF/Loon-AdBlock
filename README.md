# Loon-AdBlock

自用 Loon 综合去广告 + 分流：规则 + 插件，基于开源项目整理。

## 一键订阅（推荐）

Loon → 配置 → 插件 → 右上角 + → 从链接导入：

```
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/Loon-AdBlock.plugin
```

一个链接包含：去广告规则（REJECT）+ 按策略组分流 + 开屏去广告脚本。
策略组名须与你 Loon 内一致（Google / Spark / Instagram / X / Telegram / TikTok /
YouTube / Netflix / Streaming / Threads / AI / GitHub / Microsoft / Muse /
PUBG / HSBC专用 / wise专用 / PayPal_美国专用），未命中的流量走你原来的兜底规则。

## 分开用

| 文件 | 说明 | Loon 导入位置 |
|------|------|---------------|
| `rule/AdBlock.list` | 综合去广告规则（约 780 条）：广告/追踪域名拦截 | 规则 → 右上角 + → 从链接导入 |
| `plugin/AdBlock.plugin` | 综合去广告插件：开屏广告去除（B站/京东/爱奇艺/美团等）+ 知乎去广告 | 配置 → 插件 → 右上角 + → 从链接导入 |
| `plugin/AdBlockPlus.plugin` | **去广告强力版**：740 条开屏/广告 URL 拦截（含美团 openscreen 新接口）+ 52 条广告清理脚本 + 知乎去广告，拦截开屏广告以及所有广告 | 配置 → 插件 → 右上角 + → 从链接导入 |
| `plugin/VirtualLocation.plugin` | **虚拟定位**（独立自研）：修改 Apple 网络定位返回坐标实现虚拟定位，在插件设置里填经纬度 | 配置 → 插件 → 右上角 + → 从链接导入 |
| `rule/Routing.snippet` | 分流规则片段（[Rule] 整段）：按个人策略组定制，App → 策略组映射 + 国内直连 + 兜底 | 配置 → 编辑配置 → [Rule] 区粘贴（见文件头使用方法） |
| `rule/Ximalaya.list` | 喜马拉雅去广告规则（38 条，已并入一键订阅） | 规则 → 右上角 + → 从链接导入 |
| `rule/JD.list` | 京东去广告规则（配合 JD 插件脚本使用，已并入一键订阅） | 规则 → 右上角 + → 从链接导入 |
| `rule/NeteaseMusic.list` | 网易云音乐去广告规则（7 条，已并入一键订阅） | 规则 → 右上角 + → 从链接导入 |
| `plugin/XimalayaAdBlock.plugin` | 喜马拉雅去广告完整版（含 3 条接口复写，需 MITM） | 配置 → 插件 → 右上角 + → 从链接导入 |
| `plugin/JDAdBlock.lpx` | 京东去广告 v2（适配 15.9.50+，需 MITM） | 配置 → 插件 → 右上角 + → 从链接导入 |
| `plugin/NeteaseMusicAdBlock.lpx` | 网易云音乐去广告 v2（适配 9.5.x，需 MITM） | 配置 → 插件 → 右上角 + → 从链接导入 |
| `plugin/PingMe.plugin` | **PingMe 自动签到**（自有优化版 v1.1.0）：签到+视频奖励，30 秒超时+失败重试 3 次，抓参一体；脚本 `script/PingMeSignin.js`（基于 fmz200/奶思 版优化） | 配置 → 插件 → 右上角 + → 从链接导入 |

分开导入链接（raw）：

```
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/rule/AdBlock.list
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/rule/Ximalaya.list
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/rule/JD.list
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/rule/NeteaseMusic.list
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/plugin/AdBlock.plugin
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/plugin/AdBlockPlus.plugin
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/plugin/VirtualLocation.plugin
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/plugin/XimalayaAdBlock.plugin
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/plugin/JDAdBlock.lpx
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/plugin/NeteaseMusicAdBlock.lpx
https://raw.githubusercontent.com/IU19930516YPF/Loon-AdBlock/main/plugin/PingMe.plugin
```

## 新增来源（2026-10-16）

- **喜马拉雅去广告**：[XM040523/ximalaya-adblock](https://github.com/XM040523/ximalaya-adblock)（上游更新 2026-10-14）—— 38 条广告/埋点域名拦截 + 3 条接口复写；规则已并入 `rule/Ximalaya.list`（一键订阅自动生效），完整版（含 MITM 复写）见 `plugin/XimalayaAdBlock.plugin`
- **京东去广告 v2**：[zbsdsb/loon-adblock-plugins](https://github.com/zbsdsb/loon-adblock-plugins)（上游更新 2026-08-12）—— 适配京东 App 15.9.50+ 新协议；规则见 `rule/JD.list`，插件见 `plugin/JDAdBlock.lpx`，脚本已 vendoring 到 `script/JD_remove_ads_v2.js`
- **网易云音乐去广告 v2**：同上仓库（上游更新 2026-08-14）—— 适配网易云 9.5.x 开屏/推荐位广告；规则见 `rule/NeteaseMusic.list`，插件见 `plugin/NeteaseMusicAdBlock.lpx`，脚本已 vendoring 到 `script/NeteaseCloudMusic_ads_v2.js`
- **Loon 模块索引**：[hahapkpk/loon-index](https://github.com/hahapkpk/loon-index)（Web 工具，非规则）—— 在线索引 30+ 作者的 Loon 去广告模块，可按更新时间搜索、一键复制导入：<https://hahapkpk.github.io/loon-index/>

以上新增内容均已做安全扫描（无 zijieapi/novelapp/bytegoofy 等危险关键字，无字节系整域拦截）。

## 上游来源

- 规则基于 [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script) 的 `rule/Loon/Advertising/Advertising.list`（上游更新 2026-10-20）
- 插件基于同仓库的 `rewrite/Loon/AdvertisingScript/AdvertisingScript.plugin`（上游更新 2025-06-06）
- 强力版插件另含同仓库的 `rewrite/Loon/Advertising/Advertising.plugin`（上游更新 2025-08-26，740 条 rewrite 拦截）
- 除下述番茄/红果处理外，其余内容与上游原版一致

## 番茄小说 / 红果短剧去广告：已禁用

原因：市面常见的番茄小说去广告片段（如 `FanQieNovel.snippet`）含有
`host-suffix, zijieapi.com` 等过度拦截规则，会把字节系 App 的通用内容接口
一起拦截，导致番茄小说、红果短剧打不开。

本仓库已逐行核查：规则文件中不含此类整域拦截；插件中不添加两 App 的去广告
条目。如需两 App 的去广告，请使用单独维护的修复版片段（见文件头注释），
不要直接套用网上流传的原版。

## 使用注意

- 插件中的开屏去广告脚本需要开启 MITM 并在 iPhone 上信任 Loon 证书才生效
- 纯规则拦截（REJECT）不需要 MITM，导入即生效
- 如某 App 出现异常，先在 Loon 里停用本插件/规则排查

## 更新

上游有重要更新时手动同步。同步日期见各文件头注释。
