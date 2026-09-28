const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  session,
  safeStorage,
  net,
  dialog,
} = require("electron");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

let window = null;
let tray = null;
let quitting = false;
// 待落盘的下载：{ savePath, resolve }。download 桥在调用 downloadURL 前登记，will-download 消费一次。
let pendingDownload = null;
// ENG-10：下载桥超时清登记后，迟到的 will-download 会静默落盘到系统 Downloads——
// 记录超时时刻，此后约 130s 内触发的默认分支下载需尽力通知渲染层
let staleDownloadUntil = 0;
// 桥接令牌：每次启动随机生成，经 URL fragment 注入页面，防本机其他进程/网页调用 /bridge
const bridgeToken = crypto.randomBytes(16).toString("hex");
// 下载域名白名单 + 校验。跨域 <a download> 走主进程 downloadURL，但 downloadURL 会跟随
// 3xx 重定向——初始 URL 白名单不足以约束终链。此校验供「发起前」与「will-download 拿到
// 重定向链后」两处复用，任一环节越界即拒绝。
const DOWNLOAD_ALLOW = ["github.com", "githubusercontent.com", "gitlab.com", "gitee.com", "gitcode.com"];
// P3：单文件下载大小上限（1 GiB），防止写满磁盘。Content-Length 已知时在 will-download 先行拦截，
// 未知（chunked）时在下载过程中按已收字节兜底取消。
const DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const isAllowedDownloadUrl = (raw) => {
  let target = null;
  try { target = new URL(raw); } catch { return false; }
  if (target.protocol !== "https:") return false;
  return DOWNLOAD_ALLOW.some((d) => target.hostname === d || target.hostname.endsWith("." + d));
};

// 日志写到 userData（安装版=系统标准目录；便携版=exe 旁的 .app-data）
// 日志改为内存缓冲 + 500ms/64KB 批量刷盘（原为每次同步写盘）
let logBuffer = "";
let logTimer = null;
const flushLog = () => {
  if (logTimer) { clearTimeout(logTimer); logTimer = null; }
  if (!logBuffer) return;
  const chunk = logBuffer;
  logBuffer = "";
  try {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "main.log");
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 256 * 1024)
        fs.renameSync(logPath, path.join(dir, "main.old.log"));
    } catch {}
    fs.appendFileSync(logPath, chunk);
  } catch {}
};
const log = (msg) => {
  logBuffer += `[${new Date().toISOString()}] ${msg}\n`;
  if (logBuffer.length > 64 * 1024) flushLog();
  else if (!logTimer) logTimer = setTimeout(flushLog, 500);
};
process.on("uncaughtException", (e) => {
  log("uncaughtException: " + (e.stack || e.message));
});

// 便携模式：仅 electron-builder 的 portable 目标会在运行时设置 PORTABLE_EXECUTABLE_DIR，
// 此时用户数据放 exe 旁边；安装版（NSIS/dmg/deb）用系统标准 userData
//（%APPDATA% / ~/Library/Application Support / ~/.config），避免写入只读安装目录。
const PORTABLE_ROOT = process.env.PORTABLE_EXECUTABLE_DIR;
if (PORTABLE_ROOT) {
  app.setPath("userData", path.join(PORTABLE_ROOT, ".app-data"));
}

// 关闭行为策略：ask（每次询问）/ minimize（后台）/ exit（直接退出）
let closePolicy = "ask";
const policyFile = () => path.join(app.getPath("userData"), "close-policy.json");
const loadPolicy = () => {
  try {
    const v = fs.readFileSync(policyFile(), "utf8").trim();
    closePolicy = ["ask", "minimize", "exit"].includes(v) ? v : "ask";
  } catch {
    closePolicy = "ask";
  }
};
const savePolicy = (v) => {
  if (!["ask", "minimize", "exit"].includes(v)) return;
  closePolicy = v;
  try {
    fs.writeFileSync(policyFile(), v);
  } catch {}
};

// 网络代理：system（跟随系统）/ direct（直连）/ 自定义规则（如 127.0.0.1:7890）
const proxyFile = () => path.join(app.getPath("userData"), "proxy.txt");
let currentProxy = "system";
// ENG-9：自定义代理白名单校验（host:port 或 scheme://host:port，端口 1-65535）——
// 不合法的值在落盘/应用前就拒绝，避免坏代理假回显「已生效」并跨重启持久化
const isValidProxy = (v) => {
  const m = /^(?:(https?|socks5):\/\/)?([a-zA-Z0-9._-]+):(\d{1,5})$/.exec(v);
  if (!m) return false;
  const p = Number(m[3]);
  return p >= 1 && p <= 65535;
};
const applyProxy = async (v) => {
  try {
    if (!v || v === "system") {
      await session.defaultSession.setProxy({ mode: "system", proxyBypassRules: "localhost;127.0.0.1" });
    } else if (v === "direct") {
      await session.defaultSession.setProxy({ mode: "direct", proxyBypassRules: "localhost;127.0.0.1" });
    } else {
      // ENG-9：先校验，不合法直接报错——不调 setProxy、不改 currentProxy（保留上一个生效值）
      if (!isValidProxy(v)) {
        log("proxy rejected (invalid format): " + v);
        return { ok: false, error: "代理格式无效（应为 host:port 或 scheme://host:port，端口 1-65535）" };
      }
      await session.defaultSession.setProxy({ proxyRules: v, proxyBypassRules: "localhost;127.0.0.1" });
    }
    // 仅在 setProxy 真正成功后，才更新 currentProxy 与日志（避免假回显「已生效」）
    currentProxy = v || "system";
    log("proxy applied: " + currentProxy);
    return { ok: true, proxy: currentProxy };
  } catch (e) {
    log("proxy apply failed: " + e.message);
    return { ok: false, error: e.message }; // 保留旧 currentProxy，回显仍指向上一个生效值
  }
};
const loadProxy = async () => {
  try {
    // 注：历史坏 proxy.txt（如纯垃圾串）启动时 applyProxy 会返回 {ok:false} 但不抛——
    // currentProxy 保持初始 "system"，即坏值不再生效（修复前会原样交给 setProxy），可接受
    await applyProxy(fs.readFileSync(proxyFile(), "utf8").trim() || "system");
  } catch {
    await applyProxy("system");
  }
};
const saveProxy = async (v) => {
  // ENG-9：先 apply 成功才写盘——修复前是先落盘再 apply，apply 失败也不回滚，坏值会跨重启持久化
  const r = await applyProxy(v || "system");
  if (r.ok) { try { fs.writeFileSync(proxyFile(), v || "system"); } catch {} }
  return r;
};

const PAGE = path.join(__dirname, "console.html");
const ICON_DIR = path.join(__dirname, "build");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  let serverRetried = false;
  app.whenReady().then(async () => {
    log('app ready');
    loadPolicy();
    await loadProxy();
    // 本地静态服务：页面 + 桥接命令（后台运行 / 退出 / 策略）
    let htmlBytes = fs.readFileSync(PAGE);
    const JS_PAGE = path.join(__dirname, "console.js");
    let jsBytes = fs.readFileSync(JS_PAGE);
    let port = 58613;
    const server = http.createServer();
    const secretsFile = () => path.join(app.getPath("userData"), "tokens.enc.json");
    // 桥接 action 注册表：每个 action 一个 handler；未知 action 返回 404（便于及早暴露笔误）
    const jsonReply = (res, code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };
    const bridgeActions = {
      minimize: ({ res, remember }) => {
        if (window && !window.isDestroyed()) {
          if (remember) savePolicy("minimize");
          window.hide();
        }
        jsonReply(res, 200, { ok: true });
      },
      exit: ({ remember }) => {
        if (remember) savePolicy("exit");
        quitting = true;
        if (tray) tray.destroy();
        if (window && !window.isDestroyed()) window.destroy();
        app.quit();
      },
      theme: ({ u, res }) => {
        const dark = u.searchParams.get("dark") === "1";
        try {
          window.setTitleBarOverlay({
            color: dark ? "#0b0f1a" : "#f1f5fd",
            symbolColor: dark ? "#93a0bc" : "#5a6784",
            height: 40,
          });
        } catch {}
        jsonReply(res, 200, { ok: true });
      },
      setpolicy: ({ u, res }) => {
        savePolicy(u.searchParams.get("value") || "ask");
        jsonReply(res, 200, { ok: true, policy: closePolicy });
      },
      getpolicy: ({ res }) => jsonReply(res, 200, { policy: closePolicy }),
      setproxy: async ({ u, res }) => {
        // await 真实结果：setProxy 成功才回 {ok:true}，失败回 {ok:false,error}，前端据此决定文案
        const r = await saveProxy(u.searchParams.get("value") || "system");
        if (r.ok) jsonReply(res, 200, { ok: true, proxy: r.proxy });
        else jsonReply(res, 500, { ok: false, error: r.error });
      },
      getproxy: ({ res }) => jsonReply(res, 200, { proxy: currentProxy }),
      "secrets-get": ({ res }) => {
        try {
          const raw = JSON.parse(fs.readFileSync(secretsFile(), "utf8"));
          if (raw.plain) {
            jsonReply(res, 200, { accounts: raw.data });
          } else if (raw.enc && safeStorage.isEncryptionAvailable()) {
            const json = safeStorage.decryptString(Buffer.from(raw.data, "base64"));
            jsonReply(res, 200, { accounts: JSON.parse(json) });
          } else {
            // 库文件存在但读不出（加密不可用/格式不符）：返回错误态，渲染进程会拒绝写回，防止覆盖丢 Token
            log("secrets-get: store unreadable (enc without decryptor)");
            jsonReply(res, 200, { accounts: [], error: true });
          }
        } catch (e) {
          // 文件不存在 = 真正的空库；其余（损坏/解密异常）= 错误态，不能当空库处理
          const missing = e && e.code === "ENOENT";
          if (!missing) log("secrets-get failed: " + (e.stack || e.message));
          jsonReply(res, 200, missing ? { accounts: [] } : { accounts: [], error: true });
        }
      },
      "secrets-set": ({ res, postBody }) => {
        // P4-2：畸形 body（JSON 解析失败→postBody=null，或缺 accounts 数组）一律 400 拒绝，绝不落盘清空令牌库
        if (!postBody || !Array.isArray(postBody.accounts)) {
          log("secrets-set: rejected (malformed body)");
          jsonReply(res, 400, { ok: false, error: "malformed body" });
          return;
        }
        // 白名单重建：只落盘 platform/token/label，__proto__/constructor 等数据卫生风险键被丢弃
        const accounts = [];
        for (const raw of postBody.accounts) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          if (typeof raw.platform !== "string" || !raw.platform) continue;
          if (typeof raw.token !== "string" || !raw.token) continue;
          accounts.push({
            platform: raw.platform,
            token: raw.token,
            label: typeof raw.label === "string" && raw.label ? raw.label : raw.platform,
          });
        }
        if (accounts.length !== postBody.accounts.length)
          log("secrets-set: normalized " + (postBody.accounts.length - accounts.length) + " entries dropped");
        try {
          // 写前留一份 .bak：误覆盖/写坏时可手工找回
          try {
            if (fs.existsSync(secretsFile()))
              fs.copyFileSync(secretsFile(), secretsFile() + ".bak");
          } catch {}
          if (safeStorage.isEncryptionAvailable()) {
            const enc = safeStorage.encryptString(JSON.stringify(accounts));
            fs.writeFileSync(secretsFile(), JSON.stringify({ v: 1, enc: true, data: enc.toString("base64") }));
          } else {
            // P1-2：安全存储不可用时拒绝明文落盘（与「Windows 凭据加密存储」宣传一致），
            // 绝不写 { plain:true } 的明文文件；渲染层据此 toast 提示用户重启后需重新登录。
            log("secrets-set: safeStorage unavailable, refusing plaintext persist");
            jsonReply(res, 503, { ok: false, error: "系统安全存储不可用，已拒绝明文保存令牌" });
            return;
          }
          jsonReply(res, 200, { ok: true });
        } catch (e) {
          jsonReply(res, 500, { ok: false, error: e.message });
        }
      },
      "probe-ports": ({ res }) => {
        const netMod = require("node:net");
        const ports = [7890, 7891, 7892, 10809, 1080, 2080, 8888];
        const alive = [];
        let pending = ports.length;
        for (const port of ports) {
          const sock = netMod.createConnection({ port, host: "127.0.0.1" });
          let settled = false;
          const done = (ok) => {
            if (settled) return;
            settled = true;
            if (ok) alive.push(port);
            if (--pending === 0) {
              alive.sort((a, b) => a - b);
              jsonReply(res, 200, { ports: alive });
            }
            sock.destroy();
          };
          sock.setTimeout(1200, () => done(false));
          sock.once("connect", () => done(true));
          sock.once("error", () => done(false));
        }
      },
      buildinfo: ({ res }) => {
        let mt = "";
        try { mt = fs.statSync(process.execPath).mtime.toISOString(); } catch {}
        jsonReply(res, 200, { exe: process.execPath, mtime: mt });
      },
      ping: ({ res, postBody }) => {
        // 用 Chromium 网络栈（net.fetch）测试连通：走 session 配置的代理，
        // 与渲染进程实际 API 请求同一条网络路径，测试结论才可信（Node fetch 不读代理）。
        // host 白名单：只允许探测四个平台的 API 域，防止被当成任意 URL 探测器。
        const PING_ALLOW = {
          "api.github.com": "https://api.github.com/zen",
          "gitlab.com": "https://gitlab.com/api/v4/version",
          "gitee.com": "https://gitee.com/api/v5/user",
          // 2026-09-15：GitCode 开放 API 域为 api.gitcode.com（web-api.gitcode.com 是 CloudWAF 前端域，对 API 客户端 418 拦截）
          "api.gitcode.com": "https://api.gitcode.com/api/v5/user",
        };
        const reqHost = postBody && typeof postBody.host === "string" ? postBody.host : "api.github.com";
        const probeUrl = PING_ALLOW[reqHost];
        if (!probeUrl) {
          jsonReply(res, 400, { ok: false, error: "unknown host" });
          return;
        }
        const t0 = Date.now();
        // 401/403（无 Token 访问受保护端点）也算"网络可达"——本探测只关心连通性；
        // 但 418 是 CloudWAF 拦截页（2026-09-15 GitCode 实测：ping 假「正常」而实际 API 全被拦），必须视为不可达
        net.fetch(probeUrl, {
          headers: { "User-Agent": "GitConsole" },
          signal: AbortSignal.timeout(8000),
        })
          .then((r) => jsonReply(res, 200, { ok: r.ok || (r.status < 500 && r.status !== 418), status: r.status, ms: Date.now() - t0 }))
          .catch((e) => jsonReply(res, 200, { ok: false, error: e.message, ms: Date.now() - t0 }));
      },
      download: async ({ u, res }) => {
        // 文件页「下载」桥接：跨域 <a download> 会被浏览器忽略，故改由主进程 downloadURL 触发真实下载。
        // host 白名单：只允许平台的下载域（含必要子域），杜绝被当成任意 URL 下载器（此处不放松）。
        const raw = u.searchParams.get("url") || "";
        if (!isAllowedDownloadUrl(raw)) {
          log("download: rejected url " + raw);
          jsonReply(res, 400, { ok: false, error: "url not allowed" });
          return;
        }
        const target = new URL(raw);
        if (!window || window.isDestroyed()) {
          jsonReply(res, 500, { ok: false, error: "no window" });
          return;
        }
        // 默认文件名：取 URL 路径末段（解码后），非法字符替换为下划线；为空则回退 download
        let name = "download";
        try {
          const base = decodeURIComponent(target.pathname.split("/").filter(Boolean).pop() || "");
          if (base) name = base;
        } catch {}
        name = name.replace(/[\\/:*?"<>|]/g, "_") || "download";
        // 先弹「另存为」对话框：取消则直接返回 canceled，不发起任何下载
        let savePath = null;
        try {
          const r = await dialog.showSaveDialog(window, { title: "保存文件", defaultPath: name });
          if (r.canceled || !r.filePath) {
            jsonReply(res, 200, { ok: false, canceled: true });
            return;
          }
          savePath = r.filePath;
        } catch (e) {
          log("download: save dialog failed: " + (e.stack || e.message));
          jsonReply(res, 500, { ok: false, error: e.message });
          return;
        }
        // 登记目标路径 + 结果收集器；will-download 会据此 setSavePath，并在 done 时 resolve
        if (pendingDownload) {
          jsonReply(res, 409, { ok: false, error: "已有下载进行中，请稍后再试" });
          return;
        }
        let done = null;
        let timedOut = false;
        try {
          done = new Promise((resolve) => { pendingDownload = { savePath, resolve }; });
          window.webContents.downloadURL(target.href);
        } catch (e) {
          // downloadURL 同步抛错：立即清空登记，避免 pendingDownload 永久残留导致后续下载恒 409
          log("download: downloadURL threw: " + (e.message || e));
          pendingDownload = null;
          jsonReply(res, 500, { ok: false, error: "下载发起失败：" + (e.message || "未知错误") });
          return;
        }
        let outcome = null;
        try {
          // 120s 超时兜底：will-download 未触发/网络停滞时不再永久挂起，超时后清空登记
          outcome = await Promise.race([
            done,
            new Promise((_, reject) => setTimeout(() => { timedOut = true; reject(new Error("download timeout")); }, 120000)),
          ]);
        } catch (e) {
          if (timedOut) { pendingDownload = null; }
          outcome = null;
        }
        if (timedOut) {
          // ENG-10：此后约 130s 内迟到的 will-download 视为本次超时下载的迟到触发
          staleDownloadUntil = Date.now() + 130000;
          log("download: timed out, resetting pendingDownload");
          jsonReply(res, 200, { ok: false, error: "下载超时（120 秒无结果），请重试" });
          return;
        }
        const state = outcome && outcome.state;
        if (state === "completed") jsonReply(res, 200, { ok: true, path: savePath });
        else if (state === "cancelled") jsonReply(res, 200, { ok: false, canceled: true });
        else jsonReply(res, 200, { ok: false, error: "下载失败（" + (state || "未知状态") + "）" });
      },
    };
    const handleBridge = (u, res, postBody) => {
      const action = u.searchParams.get("action") || "";
      const remember = u.searchParams.get("remember") === "1";
      log("bridge: " + action + (remember ? " (remember)" : ""));
      const handler = bridgeActions[action];
      if (!handler) {
        jsonReply(res, 404, { ok: false, error: "unknown action: " + action });
        return;
      }
      try {
        handler({ u, res, postBody, remember, action });
      } catch (e) {
        log("bridge handler error (" + action + "): " + (e.stack || e.message));
        try { jsonReply(res, 500, { ok: false, error: "internal error" }); } catch {}
      }
    };
      const bridgeGet = (req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        handleBridge(u, res, null);
      };
      const bridgePost = (req, res) => {
        // FIX(m-1/m-2)：原来 body += c 是按块把 Buffer 强转字符串——多字节 UTF-8 字符
        // 恰好被 TCP 分块切在字节中间时，逐块 toString 会产生 U+FFFD 乱码（中文账号 label
        // 会损坏）；且 2MB 上限按 UTF-16 码元（body.length）计，多字节载荷实际字节数可达
        // 上限的近 2 倍。改为 Buffer 数组累积 + Buffer.concat 一次性解码，上限改按 UTF-8 字节。
        const chunks = [];
        let totalBytes = 0;
        let oversized = false;
        req.on("data", (c) => {
          if (oversized) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          totalBytes += buf.length;
          if (totalBytes > 2 * 1024 * 1024) {
            oversized = true;
            res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "payload too large (2MB limit)" }));
            req.destroy();
            return;
          }
          chunks.push(buf);
        });
        req.on("end", () => {
          if (oversized) return;
          const body = Buffer.concat(chunks).toString("utf8");
          const u = new URL(req.url, "http://127.0.0.1");
          let postBody = null;
          try { postBody = JSON.parse(body || "{}"); } catch {}
          handleBridge(u, res, postBody);
        });
      };
      server.on("request", (req, res) => {
        const org = req.headers.origin;
        if (org && org !== "http://127.0.0.1:" + port) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "cross-origin rejected" }));
          return;
        }
        if (req.url.startsWith("/bridge")) {
          if (u_tk_ok(req)) {
            if (req.method === "POST") bridgePost(req, res);
            else bridgeGet(req, res);
          } else {
            log("bridge: rejected (bad token)");
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("forbidden");
          }
          return;
        }
        if (req.url.startsWith("/console.js")) {
          res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
          res.end(jsBytes);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(htmlBytes);
      });
      const u_tk_ok = (req) => {
        const u = new URL(req.url, "http://127.0.0.1");
        // FIX(n-1)：令牌比较改常量时间，避免本地服务上的理论定时侧信道
        const tk = u.searchParams.get("tk") || "";
        const a = Buffer.from(tk);
        const b = Buffer.from(bridgeToken);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      };
    // CSP：掐死任何把 Token 外带的通道
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: Object.assign({}, details.responseHeaders, {
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "connect-src 'self' https://api.github.com https://gitlab.com https://api.gitcode.com https://gitee.com; " +
            "img-src 'self' data: https://avatars.githubusercontent.com https://*.githubusercontent.com https://gitlab.com https://gitee.com https://portrait.gitee.com https://gitcode.com https://cdn-img.gitcode.com https://cdn-static.gitcode.com https://secure.gravatar.com; font-src 'self' data:; base-uri 'none'; object-src 'none'",
          ],
        }),
      });
    });
    // 端口被占就换随机端口
    server.on("error", (e) => {
      log("server error: " + (e.code || e.message));
      if (!serverRetried) {
        serverRetried = true;
        server.close();
        server.listen(0, "127.0.0.1");
      } else {
        dialog.showErrorBox("Git 控制台", "本地服务端口初始化失败：" + (e.code || e.message) + "\n请关闭应用后重新打开。");
        app.quit();
      }
    });
    server.listen(port, "127.0.0.1");
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.once("listening", resolve);
    });
    port = server.address().port;
    log('server listening on ' + port);

    window = new BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 880,
      minHeight: 560,
      title: "Git 控制台",
      icon: path.join(ICON_DIR, "icon.ico"),
      backgroundColor: "#f6f8fe",
      show: false,
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#f1f5fd",
        symbolColor: "#5a6784",
        height: 40,
      },
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    Menu.setApplicationMenu(null);

    const showMainWindow = () => {
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    };

    // 托盘：高分辨率透明 PNG（圆角外全透明，不会出现白色一圈）
    const trayImage = nativeImage.createFromPath(
      path.join(ICON_DIR, "tray.png"),
    );
    tray = new Tray(
      trayImage.isEmpty()
        ? await app.getFileIcon(process.execPath, { size: "small" })
        : trayImage,
    );
    tray.setToolTip("Git 控制台");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示主窗口", click: showMainWindow },
        { type: "separator" },
        {
          label: "退出",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("double-click", showMainWindow);

    // 外链走系统浏览器；站内不许导航走
    session.defaultSession.setPermissionRequestHandler(
      (_wc, _permission, cb) => cb(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    const origin = `http://127.0.0.1:${port}`;
    const isSameOrigin = (url) => {
      try {
        return new URL(url).origin === origin;
      } catch {
        return false;
      }
    };
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && !isSameOrigin(url))
        void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!isSameOrigin(url)) event.preventDefault();
    });
    // FIX(n-2)：主框架 3xx 重定向走的是 will-redirect，与 will-navigate 分开触发——
    // 只拦 will-navigate 时，一次同源重定向到外站即可把窗口带离可信页面。补同一道 origin 校验。
    window.webContents.on("will-redirect", (event, url) => {
      if (!isSameOrigin(url)) event.preventDefault();
    });

    // 下载落盘：webContents.downloadURL 会触发 will-download。实测「未挂 will-download 监听」时
    // Electron 不会自动落盘（依赖默认另存为对话框，无监听/无交互环境下不会生成文件），故显式挂监听。
    // 若 download 桥已登记 pendingDownload（用户刚在「另存为」里选定路径），则用该路径 setSavePath，
    // 并在 done 时把真实结果（completed/cancelled/interrupted）resolve 回桥接请求——不再无条件报成功。
    session.defaultSession.on("will-download", (_event, item) => {
      // FIX(n-6)：重定向终链复检。downloadURL 会跟随 3xx 重定向，发起前的初始 URL 白名单
      // 拦不住「白名单域重定向到内网/非 https」的终链。这里取完整重定向链逐段复检，任一越界即取消。
      let chain = [];
      try { chain = item.getURLChain() || []; } catch {}
      const chainUrls = chain.length ? chain : [item.getURL()];
      if (chainUrls.some((url) => !isAllowedDownloadUrl(url))) {
        log("download: cancelled (redirect escaped whitelist): " + (chain.join(" -> ") || item.getURL()));
        const pd = pendingDownload;
        pendingDownload = null;
        if (pd && typeof pd.resolve === "function") pd.resolve({ state: "cancelled" });
        item.cancel();
        return;
      }
      const total = item.getTotalBytes();
      if (total > DOWNLOAD_MAX_BYTES) {
        log("download: cancelled (too large, total=" + total + "): " + (item.getURL() || ""));
        const pd = pendingDownload;
        pendingDownload = null;
        if (pd && typeof pd.resolve === "function") pd.resolve({ state: "cancelled" });
        item.cancel();
        return;
      }
      const pd = pendingDownload;
      pendingDownload = null; // 单次消费
      let savePath;
      if (pd && pd.savePath) {
        savePath = pd.savePath;
      } else {
        const name = (item.getFilename() || "download").replace(/[\\/:*?"<>|]/g, "_");
        savePath = path.join(app.getPath("downloads"), name);
        // ENG-10：迟到的下载（超时清登记后才触发）会静默落盘到系统 Downloads——
        // 尽力通知渲染层 toast；窗口已销毁等场景全程 try/catch 静默
        if (Date.now() < staleDownloadUntil) {
          log("download: late will-download saved to system Downloads: " + name);
          try {
            window.webContents.executeJavaScript("toast(" + JSON.stringify("一个迟到的下载已保存到系统下载目录：" + name) + ");");
          } catch {}
        }
      }
      item.setSavePath(savePath);
      // 未知长度下载（Content-Length 缺失/chunked）的兜底：按已收字节实时取消
      item.on("updated", (_e, _state) => {
        if (item.getReceivedBytes() > DOWNLOAD_MAX_BYTES) {
          log("download: cancelled (exceeded size limit): " + (item.getURL() || ""));
          if (pd && typeof pd.resolve === "function") pd.resolve({ state: "cancelled" });
          item.cancel();
        }
      });
      item.once("done", (_e, state) => {
        log("download " + state + ": " + savePath);
        if (pd && typeof pd.resolve === "function") pd.resolve({ state, savePath });
      });
    });

    window.once("ready-to-show", () => { log('ready-to-show'); window.show(); });
    window.webContents.on('did-finish-load', () => log('did-finish-load'));
    window.webContents.on('did-fail-load', (_e, code, desc) => log('did-fail-load ' + code + ' ' + desc));

    // 点 X：按策略处理——ask 弹询问，minimize 直接后台，exit 直接退出
    window.on("close", (event) => {
      if (quitting) return;
      if (closePolicy === "minimize") {
        event.preventDefault();
        window.hide();
        return;
      }
      if (closePolicy === "exit") {
        quitting = true;
        return; // 不拦截，走正常关闭 → window-all-closed → quit
      }
      event.preventDefault();
      void window.webContents.executeJavaScript(
        "if (window.showCloseAsk) showCloseAsk();",
      ).catch(() => {});
    });

    app.on("before-quit", () => {
      quitting = true;
      flushLog();
    });

    const loadTarget = `http://127.0.0.1:${port}/#tk=${bridgeToken}`;
    let loaded = false;
    for (let attempt = 1; attempt <= 2 && !loaded; attempt++) {
      try {
        await window.loadURL(loadTarget);
        loaded = true;
      } catch (e) {
        log("loadURL attempt " + attempt + " failed: " + (e.message || e));
        if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (!loaded) {
      dialog.showErrorBox("Git 控制台", "页面加载失败，本地服务可能异常。\n请完全退出应用（托盘右键 → 退出）后重新打开。");
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });
}
