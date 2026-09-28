# Changelog

本项目的重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.0.1] - 2026-09-28

### Fixed

- **多字节 UTF-8 跨块损坏**：`desktop.cjs` 的 `bridgePost` 原来按块把 Buffer 强转字符串（`body += c`），中文账号 label 等非 ASCII 字符恰好被 TCP 分块切在字节中间时会产生 U+FFFD 乱码；改为 Buffer 数组累积 + `Buffer.concat` 一次性解码。
- **请求体上限口径**：2MB 上限由「UTF-16 码元」改为「UTF-8 字节」计数，多字节载荷不再能超近 2 倍体积绕过。
- **XSS 转义遗漏**：`console.html` 目录树条目的 `data-type` 与仓库卡片复选框的 `data-check` 补上 `esc()`，与同处其它字段口径一致。

### Security

- **令牌常量时间比较**：桥接令牌校验由 `===` 改为 `crypto.timingSafeEqual`，消除本地服务上的理论定时侧信道。
- **导航纵深**：补 `will-redirect` 守卫，与 `will-navigate` 同口径拦截跨源重定向，堵住「同源重定向带出窗口」的纵深缺口。

### Added

- 补 `README.md`（项目说明 / 目录结构 / 令牌存储 / 打包 / 测试）、`CHANGELOG.md`、`.gitignore`，并初始化 Git 仓库。
- 明确 `parts/` 已废弃，`electron-app/console.html` 为唯一事实源。

## [1.0.0] - 2026-09-15

首个可用版本：四平台（GitHub / GitLab / Gitee / GitCode）仓库、文件、Issue、PR、Release、Gist、收藏、通知管理；多账号 + safeStorage 加密令牌库；桥接本地服务。
