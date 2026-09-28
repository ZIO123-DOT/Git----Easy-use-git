# Changelog

本项目的重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.0.5] - 2026-09-29

### Fixed

- **修复 Linux `.deb` 构建失败**：`package.json` 的 `author` 补上 email（deb 包需要 maintainer email），否则 electron-builder 报 `Please specify author 'email'`。

## [1.0.4] - 2026-09-29

### Changed

- **打包改为 electron-builder，产出真正安装包**：Windows（NSIS 安装器 + 便携 exe）、macOS（dmg + zip）、Linux（AppImage + deb），替换原先只能出免安装文件夹的 `@electron/packager`。
- **安装版数据目录改用系统标准位置**：安装版用户数据写入 `%APPDATA%\Git 控制台` / `~/Library/Application Support/Git 控制台` / `~/.config/Git 控制台`，便携版仍放 exe 旁 `.app-data`；`main.log` 同步写入 userData。
- **三平台 GitHub Actions 自动构建发布**：`.github/workflows/build.yml` 用 windows/macos/ubuntu 矩阵构建，`v*` 标签推送后自动发 Release（替换原仅 macOS 的 workflow）。

## [1.0.3] - 2026-09-28

### Security

- **Gitee 认证改走请求头**：Gitee 的 `access_token` 由 URL query 改为 `Authorization: token <token>` 头（与 GitHub/GitLab/GitCode 口径一致），token 不再流经代理与访问日志；登录探测同步对齐。
- **安全存储不可用时拒绝明文落盘**：`safeStorage` 不可用（加密后端缺失）时 `secrets-set` 直接返回 503、绝不写 `{ plain:true }` 的明文文件，与「Windows 凭据加密存储」宣传一致；浏览器/Edge 文件协议模式保留 localStorage 但首次落盘时弹一次性明文告警。

### Fixed

- **局部 innerHTML 转义收口**：网络诊断、代理端口探测、代理测试三处 `innerHTML` 对主进程回传的动态值补 `esc()`（其中两处改为 `textContent`），消除潜在注入 sink。
- **下载大小上限**：`will-download` 增加 1 GiB 上限（Content-Length 已知时前置拦截，未知时按已收字节实时取消），防止写满磁盘。
- **saveAccounts 异步化 + 重试**：令牌保存改为 `async` 并带一次重试，写失败明确 toast 而非 fire-and-forget 静默丢失。

## [1.0.2] - 2026-09-28

### Security

- **移除 CSP `script-src 'unsafe-inline'`**：`console.html` 的 4 个内联 `<script>` 外置为独立的 `console.js`，26 个内联 `onclick` 改为 `data-act` 属性 + 单一事件委托分发器；`desktop.cjs` 新增 `/console.js` 静态路由并收紧 CSP 为 `script-src 'self'`。此前 XSS 纵深防御完全依赖 `esc()` 无遗漏，现在内联脚本与内联事件处理器在浏览器层被直接阻断。

### Fixed

- **`confirmModal` 潜在 XSS sink**：`body` 字段改为默认 `esc()` 转义，需保留 `<b>` 等标记的调用点改走新增的 `bodyHtml` 逃生舱（8 处调用点已同步），堵住未来调用方遗漏转义时直接注入 DOM 的隐患。

## [1.0.1] - 2026-09-28

### Fixed

- **多字节 UTF-8 跨块损坏**：`desktop.cjs` 的 `bridgePost` 原来按块把 Buffer 强转字符串（`body += c`），中文账号 label 等非 ASCII 字符恰好被 TCP 分块切在字节中间时会产生 U+FFFD 乱码；改为 Buffer 数组累积 + `Buffer.concat` 一次性解码。
- **请求体上限口径**：2MB 上限由「UTF-16 码元」改为「UTF-8 字节」计数，多字节载荷不再能超近 2 倍体积绕过。
- **XSS 转义遗漏**：`console.html` 目录树条目的 `data-type` 与仓库卡片复选框的 `data-check` 补上 `esc()`，与同处其它字段口径一致。

### Security

- **令牌常量时间比较**：桥接令牌校验由 `===` 改为 `crypto.timingSafeEqual`，消除本地服务上的理论定时侧信道。
- **导航纵深**：补 `will-redirect` 守卫，与 `will-navigate` 同口径拦截跨源重定向，堵住「同源重定向带出窗口」的纵深缺口。
- **下载重定向终链复检**：`will-download` 里取 `item.getURLChain()` 逐段复检 host 白名单 + https，堵住「白名单域 3xx 重定向到内网/非 https 终链」的盲 SSRF 面。

### Added

- 补 `README.md`（项目说明 / 目录结构 / 令牌存储 / 打包 / 测试）、`CHANGELOG.md`、`.gitignore`，并初始化 Git 仓库。
- 明确 `parts/` 已废弃，`electron-app/console.html` 为唯一事实源。

## [1.0.0] - 2026-09-15

首个可用版本：四平台（GitHub / GitLab / Gitee / GitCode）仓库、文件、Issue、PR、Release、Gist、收藏、通知管理；多账号 + safeStorage 加密令牌库；桥接本地服务。
