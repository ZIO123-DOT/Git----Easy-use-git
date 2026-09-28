# Git 控制台（multi-git-desktop）

本地多平台 Git 管理桌面应用。在一个窗口里管理 **GitHub / GitLab / Gitee / GitCode** 四家平台的仓库、文件、Issue、Pull Request、Release、Gist、收藏与通知，并支持拖拽批量上传。所有请求直接从本机发往平台官方 API，Token 只保存在你自己的电脑上。

## 功能

- **多账号**：可绑定多平台多账号，一键切换；Token 权限与 API 余量实时提示
- **仓库**：浏览、搜索、新建、删除（批量）、收藏、Fork、改名、改可见性
- **文件**：目录树浏览、文本/图片预览、新建/编辑/删除文件、拖拽批量上传（含 .gitignore 规则）
- **协作**：Issue、Pull Request、Release、Commit 历史、分支管理（含 GitLab 嵌套组适配）
- **其它**：Gist、通知、Actions 运行、代理设置与端口探测

## 安装与运行

各平台安装包在 [Releases](../../releases) 发布（未签名，见下方说明）。

### Windows

- **安装版（推荐）**：运行 `multi-git-desktop-*-windows-setup.exe`，按向导安装。会创建桌面 / 开始菜单快捷方式和卸载程序，无需管理员权限（按用户安装）。
- **便携版**：运行 `multi-git-desktop-*-windows-portable.exe`，单文件、免安装，数据保存在 exe 旁边。

### macOS

- 打开 `multi-git-desktop-*-macos-*.dmg`，把 `Git 控制台` 拖入「应用程序」。
- ⚠️ 未签名（ad-hoc 签名）：首次打开请「右键 → 打开」绕过 Gatekeeper。

### Linux

- `.AppImage`：`chmod +x multi-git-desktop-*.AppImage && ./multi-git-desktop-*.AppImage`
- `.deb`：`sudo dpkg -i multi-git-desktop-*.deb`

### 开发态（本机有 Electron）

```bash
cd electron-app
npx electron .
```

页面加载于 `http://127.0.0.1:<port>/#tk=<随机令牌>`，令牌经 URL fragment 注入；桥接命令（退出/最小化/代理/令牌库）经主进程本地 HTTP 服务处理。

## 打包

使用 `electron-builder`（配置见 `electron-app/electron-builder.yml`）：

```bash
cd electron-app
npm install                       # 安装 electron + electron-builder
npm run build:win                 # Windows：NSIS 安装器 + 便携版
npm run build:mac                 # macOS：dmg + zip（arm64 + x64）
npm run build:linux               # Linux：AppImage + deb
```

> 各平台安装包必须在对应系统上构建（electron-builder 不支持跨平台交叉出安装包）。仓库内 `.github/workflows/build.yml` 用三系统矩阵（windows / macos / ubuntu）自动构建，`v*` 标签推送后自动发布到 GitHub Release。
>
> 产物**未签名**（无证书）：Windows 首次有 SmartScreen 提示、macOS 需「右键 → 打开」。正式分发请配置代码签名。

## 目录结构

| 路径 | 说明 |
|---|---|
| `electron-app/` | **唯一事实源**（打包入口）：`desktop.cjs`（主进程）、`console.js`（前端逻辑源码）、`console.html`（HTML 骨架，`<script src="console.js">`）、`electron-builder.yml`（打包配置）、`build-resources/`（安装包图标） |
| `console.js`（根） | 与 `electron-app/console.js` 逐字节一致的副本，供「Edge app 模式」（file: 协议）加载 |
| `github-console.html` | 与 `electron-app/console.html` 同内容的副本 |
| `parts/` | ⚠️ **已废弃**：早期模块化源，自 2026-09-15 起未再回写。`merge_parts.py` 内置防回退闸，会拒绝用它覆盖现行产物。**改码直接改 `electron-app/console.js`** |

## Token 存储

- 桌面版：平台 Token 经 Electron `safeStorage` 加密，存于用户数据目录 `tokens.enc.json`
  - 安装版：`%APPDATA%\Git 控制台`（Windows）/ `~/Library/Application Support/Git 控制台`（macOS）/ `~/.config/Git 控制台`（Linux）
  - 便携版：exe 旁的 `.app-data/`
- 安全存储不可用（换机/换用户后密钥失效）时**拒绝明文落盘**，进入只读模式，禁止空库写回防止误覆盖丢 Token
- Edge app 模式（file: 协议）：无加密后端，回退 `localStorage` 明文（首次落盘弹一次性告警）

## 测试

```bash
cd electron-app
for t in tests/*.test.mjs; do node "$t" || exit 1; done
```

共 8 个测试文件、300+ 断言，直接从 `console.js` 提取真实源码验证。覆盖：GitLab 适配器全路由、收藏/切账号竞态守卫、拖拽上传、会话重置，以及变异测试（MUT-*）证明守卫断言真实有效。

## 安全说明

- 所有请求直接从本机发往平台官方 API，不经过任何第三方服务器
- 桥接本地服务只监听回环地址，令牌校验用常量时间比较（`timingSafeEqual`）
- 下载带 host 白名单 + https + 重定向终链复检 + 大小上限
- 安装版卸载时如需清除数据，请手动删除上述用户数据目录；便携版删除 exe 所在目录即清除全部数据
