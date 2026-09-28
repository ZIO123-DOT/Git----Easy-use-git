# Git 控制台（git-console-pro）

本地多平台 Git 管理桌面应用。在一个窗口里管理 GitHub / GitLab / Gitee / GitCode 四家平台的仓库、文件、Issue、Pull Request、Release、Gist、收藏与通知，并支持拖拽批量上传。

## 功能

- 多账号：可绑定多平台多账号，一键切换
- 仓库：浏览、搜索、新建、删除（批量）、收藏、Fork、改名、改可见性
- 文件：目录树浏览、文本/图片预览、新建/编辑/删除文件、拖拽批量上传
- 协作：Issue、Pull Request、Release、Commit 历史、分支管理
- 其它：Gist、通知、Actions 运行、API 余量与 Token 权限提示

## 运行

双击桌面的「Git 控制台」快捷方式，或运行 `release/Git 控制台-win32-x64/Git 控制台.exe`。

开发态（不打包）直接跑：

```bash
cd electron-app
# 需要本机已安装 electron，然后：
npx electron .   # 或 electron desktop.cjs
```

页面加载于 `http://127.0.0.1:<port>/#tk=<随机令牌>`，令牌经 URL fragment 注入，桥接命令（退出/最小化/代理/令牌库）经主进程本地 HTTP 服务处理。

## 目录结构

| 路径 | 说明 |
|---|---|
| `electron-app/` | **唯一事实源**（打包入口）：desktop.cjs（主进程）+ console.html（前端）+ build-desktop.mjs（打包脚本） |
| `github-console.html` | 与 `electron-app/console.html` 同内容的副本，供「Edge app 模式」（file: 协议）加载 |
| `parts/` | ⚠️ **已废弃**：早期模块化源，自 2026-09-15 起未再回写，已落后于现行产物。`merge_parts.py` 内置防回退闸，会拒绝用它覆盖现行产物。**请勿再编辑 parts/**，改码直接改 `electron-app/console.html` |

## 令牌存储

- 桌面版：平台 Token 经 Electron `safeStorage`（Windows DPAPI）加密，存于 `<应用数据>/.app-data/tokens.enc.json`
- Edge app 模式（file: 协议）：无加密后端，回退 `localStorage` 明文（已知限制）
- 加密库不可读时（换机/换用户后 DPAPI 失效）进入只读模式，禁止空库写回，防止误覆盖丢 Token

## 打包

```bash
cd electron-app
node build-desktop.mjs   # 复用 deepseek-harness 的 electron 缓存，零下载
```

## 测试

```bash
cd electron-app
node --test tests/*.test.mjs
```

覆盖：GitLab 适配器全路由分支、收藏/切账号竞态守卫、拖拽上传、会话重置、回归用例（含变异测试验证守卫敏感性）。
