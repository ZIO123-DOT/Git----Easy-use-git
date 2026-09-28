// ENG-1~10 回归测试（QA Edward，零依赖，直接从 console.html / desktop.cjs 提取真实源码验证）
// 运行：node tests/fix-eng-regression.test.mjs
// 变异验证：AUDIT_TARGET 环境变量可指向修复前备份目录（如 .audit/.backup-before-fix-20260915-174041），
//   对修复前代码跑一遍应大量变红（证明断言真能捕获回归）；默认读工作区当前产物，应全绿。
// 断言分两组：
//   [MUT]  变异组——针对 ENG 修复本身，对修复前代码必须红
//   [STRUCT] 结构组——断言「从来如此」的既有行为，不参与变异验证
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.AUDIT_TARGET
  ? (path.isAbsolute(process.env.AUDIT_TARGET) ? process.env.AUDIT_TARGET : path.resolve(here, "..", process.env.AUDIT_TARGET))
  : path.resolve(here, "..");
const html = fs.readFileSync(path.join(target, "console.html"), "utf8");
const cjs = fs.readFileSync(path.join(target, "desktop.cjs"), "utf8");
const isBackupRun = !!process.env.AUDIT_TARGET;

// ---- 提取工具：花括号配对截取函数/常量源码（与 review-audit.test.mjs 同法） ----
function extractFn(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error("未找到 " + marker);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("花括号不配对: " + marker);
}

const srcOpenUpload = extractFn(html, "function openUploadModal(");
const srcBindSearch = extractFn(html, "function bindSearchResults(");
const srcLoadRuns = extractFn(html, "async function loadRuns(");
const srcOpenGist = extractFn(html, "async function openGist(");
const srcOpenRepo = extractFn(html, "async function openRepo(");
const srcLoadReleases = extractFn(html, "async function loadReleases(");
const srcLoadAccounts = extractFn(html, "async function loadAccounts(");
// ENG-9 的 isValidProxy 是修复时新增函数，修复前产物里不存在——容错提取（缺失时相关断言在变异轮应红）
const tryExtract = (src, marker) => src.includes(marker) ? extractFn(src, marker) : null;
const srcValidProxy = tryExtract(cjs, "const isValidProxy = (v) =>");
const srcSaveProxy = tryExtract(cjs, "const saveProxy = async (v) =>");

// esc（真实实现，供运行时断言拼模板用）
const escLine = html.split("\n").find(l => l.startsWith("const esc ="));
const esc = eval("(" + escLine.replace("const esc =", "").trim().replace(/;$/, "") + ")");

// GITLAB 适配器（真实执行对象，与 review-audit.test.mjs 同法）
const gi = html.indexOf("const GITLAB = {");
let gdepth = 0, gend = -1;
for (let i = gi; i < html.length; i++) {
  if (html[i] === "{") gdepth++;
  else if (html[i] === "}") { gdepth--; if (gdepth === 0) { gend = i + 1; break; } }
}
const GITLAB = eval("(function(){" + html.slice(gi, gend) + "; return GITLAB; })()");

let mutPass = 0, mutFail = 0, structPass = 0, structFail = 0;
const check = (name, cond, detail, struct = false) => {
  const tag = struct ? "[STRUCT]" : "[MUT]";
  if (cond) { struct ? structPass++ : mutPass++; console.log("PASS", tag, name); }
  else { struct ? structFail++ : mutFail++; console.error("FAIL", tag, name, "->", detail); }
};

/* ============ ENG-1：上传弹窗在打开时捕获 repoFull/dir，循环内不读实时 state ============ */
{
  // [runtime] 打开弹窗 → 立刻篡改 state.repo/state.path（模拟 await 期间用户切仓库/切目录）→ 点「开始上传」
  // → 上传必须仍打到捕获的 own/orig + orig/dir（修复前会打到 other/other，剩余文件传错仓库）
  const drive = async () => {
    const state = { branch: "main", repo: { full_name: "own/orig" }, path: "orig/dir" };
    const uploads = [];
    const handlers = {};
    const el = () => ({
      addEventListener: (ev, fn) => { handlers[ev] = fn; },
      disabled: false, textContent: "", innerHTML: "", checked: false,
      classList: { add() {}, remove() {} },
    });
    const uploadOne = async (repoFull, p) => { uploads.push([repoFull, p]); return { ok: true }; };
    // UploadDock 桩：任务面板化后 openUploadModal 通过该门面创建任务卡片并入队；
    // enqueue 直接运行 = 测试内联执行上传循环（语义与无并发时的真实队列一致）
    const dockStub = {
      depth: () => 0,
      createTask: () => ({ abortRequested: false, state: "queued" }),
      setState: () => {}, setCount: () => {}, setLines: () => {},
      enqueue: (run) => run(),
      updateSummary: () => {},
    };
    new Function("state", "uploadOne", "openModal", "$", "toast", "esc", "closeModal", "loadContents", "DROP_LIMIT", "verifyUpload", "UploadDock",
      srcOpenUpload + "\nopenUploadModal([{ path: 'a.txt', file: { size: 1024 } }, { path: 'b.txt', file: { size: 2048 } }], false);")(
      state, uploadOne, () => {}, () => el(), () => {}, esc, () => {}, () => {}, 20, async () => ({ status: "ok" }), dockStub);
    // 弹窗已打开，此刻用户切到别的仓库/目录
    state.repo = { full_name: "other/other" };
    state.path = "other/dir";
    await handlers["click"]();
    return uploads;
  };
  const uploads = await drive();
  check("ENG-1 [runtime] 弹窗打开后切仓库/目录，两个文件仍上传到捕获的 repoFull/dir",
    uploads.length === 2 && uploads.every(u => u[0] === "own/orig" && u[1].startsWith("orig/dir/")),
    JSON.stringify(uploads));
  check("ENG-1 上传循环调用点用捕获变量 repoFull/dir（非实时 state）",
    /uploadOne\(repoFull, \(dir \? dir \+ '\/' : ''\) \+ f\.path/.test(srcOpenUpload) &&
    !/uploadOne\(state\./.test(srcOpenUpload), "");
}

/* ============ ENG-2：bindSearchResults 两处回调写回 #gs-results 并重新 bind ============ */
{
  const writes = (srcBindSearch.match(/\$\('#gs-results'\)\.innerHTML = renderSearchResults\(\)/g) || []).length;
  const rebinds = (srcBindSearch.match(/bindSearchResults\(\)/g) || []).length;
  check("ENG-2 star/unstar 回调把渲染结果写回 #gs-results（裸调用 renderSearchResults 是 no-op）",
    writes === 2, "writes=" + writes);
  check("ENG-2 写回后重新 bind（新 DOM 上的按钮才有事件）",
    rebinds >= 2 && /innerHTML = renderSearchResults\(\); bindSearchResults\(\)/.test(srcBindSearch), "rebinds=" + rebinds);
}

/* ============ ENG-3：loadRuns 发起即递增代际（Actions 先渲染不被晚到的文件列表覆盖） ============ */
{
  // [runtime-a] 旧 loadContents（gen=3）在 loadRuns 完成后才回来：修复后 loadRuns 已 ++reqGen(=4)，旧响应守卫拦截；
  // 修复前只捕获（仍为 3），旧响应自认仍属当前代际 → 覆盖 Actions 视图
  const staleOverwrite = async () => {
    const state = { reqGen: 3, repo: { full_name: "o/r" } };
    const body = { innerHTML: "" };
    const api = async () => { await new Promise(r => setTimeout(r, 5)); return { workflow_runs: [] }; };
    await new Function("state", "$", "api", "esc", "icon", "timeAgo", "runBadge",
      srcLoadRuns + "\nreturn loadRuns();")(state, () => body, api, esc, () => "", () => "", () => "");
    // loadRuns 已完成；此刻模拟「先于 Actions 发起、晚于其完成」的旧 loadContents 响应按捕获的 gen=3 检查代际并写回
    const oldGen = 3;
    if (oldGen === state.reqGen) body.innerHTML = "文件列表（旧响应覆盖了 Actions）";
    return body.innerHTML;
  };
  const body1 = await staleOverwrite();
  check("ENG-3 [runtime] loadRuns 发起即 ++reqGen，旧 loadContents 响应不再覆盖 Actions 视图",
    !body1.includes("文件列表（旧响应覆盖了 Actions）"), body1.slice(0, 80));

  // [STRUCT] 该守卫（gen !== state.reqGen 时丢弃自身晚到响应）先于 ENG-3 存在（BUG-D 轮已加），
  // 修复前产物同样通过 → 属「从来如此」行为，不参与变异验证
  const staleSelf = async () => {
    const state = { reqGen: 3, repo: { full_name: "o/r" } };
    const body = { innerHTML: "" };
    const api = async () => { state.reqGen = 99; return { workflow_runs: [] }; };
    await new Function("state", "$", "api", "esc", "icon", "timeAgo", "runBadge",
      srcLoadRuns + "\nreturn loadRuns();")(state, () => body, api, esc, () => "", () => "", () => "");
    return body.innerHTML;
  };
  const body2 = await staleSelf();
  check("ENG-3 [STRUCT][runtime] loadRuns 被 reqGen 作废时晚到响应不写回 #repo-body（守卫先于 ENG-3 存在）",
    body2.includes("正在加载 Actions"), body2.slice(0, 80), true);
  check("ENG-3 loadRuns 发起即递增（const gen = ++state.reqGen）",
    /const gen = \+\+state\.reqGen/.test(srcLoadRuns), "");
}

/* ============ ENG-4：GitLab Release 含 / 或 % 的 tag——normalize 预编码 id，DELETE 直拼不破坏路径 ============ */
{
  // [runtime] normalize：id = encodeURIComponent(tag_name)，tag_name 保持原值供显示
  const normed = GITLAB.normalize([{ tag_name: "release/v1", name: "R1", released_at: "2026-01-01" }], "releases");
  check("ENG-4 [runtime] GitLab releases normalize 后 id 为 encodeURIComponent(tag_name)",
    normed.length === 1 && normed[0].id === "release%2Fv1" && normed[0].tag_name === "release/v1",
    JSON.stringify(normed[0]));
  // [STRUCT] translate 对「已预编码」的 release id 本就直拼（从来如此）——修复点在 normalize 预编码，
  // 修复前产物对同一路径同样产出该 URL → 不参与变异验证
  let url1 = null, threw1 = false;
  try { url1 = GITLAB.translate("DELETE", "/repos/o/r/releases/release%2Fv1").url; }
  catch { threw1 = true; }
  check("ENG-4 [STRUCT][runtime] DELETE release%2Fv1 产出合法 URL 且不抛异常（translate 直拼为既有行为）",
    !threw1 && url1 === "/projects/o%2Fr/releases/release%2Fv1", "threw=" + threw1 + " url=" + url1, true);
  // [runtime] 含 % 的 tag（v1%beta → v1%25beta）：decode 会让 % 抛 URIError，直拼必须原样放行
  const normed2 = GITLAB.normalize([{ tag_name: "v1%beta" }], "releases");
  let url2 = null, threw2 = false;
  try { url2 = GITLAB.translate("DELETE", "/repos/o/r/releases/v1%25beta").url; }
  catch { threw2 = true; }
  check("ENG-4 [runtime] 含 % 的 tag（v1%25beta）DELETE 不抛 URIError、无 %2525 二次编码",
    normed2[0].id === "v1%25beta" && !threw2 && url2 === "/projects/o%2Fr/releases/v1%25beta",
    "id=" + (normed2[0] || {}).id + " threw=" + threw2 + " url=" + url2);
}

/* ============ ENG-5：openGist 递增代际，await 后守卫 return（慢响应不覆盖后点开的弹窗） ============ */
{
  check("ENG-5 openGist 发起即 ++reqGen（写 #modal 的请求与 openPrFiles 同构）",
    /const gen = \+\+state\.reqGen/.test(srcOpenGist), "");
  check("ENG-5 openGist await api 之后立即守卫 return",
    /const g = await api\('GET', '\/gists\/' \+ id\);\s*if \(gen !== state\.reqGen\) return/.test(srcOpenGist), "");
}

/* ============ ENG-6：openRepo 递增代际——快速连点两仓库，先点开的慢响应不得覆盖详情页 ============ */
{
  // [runtime] 连点 slow（40ms）→ fast（5ms）：fast 先完成，slow 晚到必须被守卫丢弃。
  // 修复前（只捕获不递增）：两请求 gen 相同，slow 的响应最后写回 state.repo → 危险操作作用于错误仓库
  const race = async () => {
    const state = { reqGen: 0, repo: { full_name: "old/old" }, branches: [], branch: "", path: "", file: null, tab: "" };
    const view = { innerHTML: "" };
    const api = async (m, p) => {
      if (p === "/repos/slow/slow") await new Promise(r => setTimeout(r, 40));
      if (p === "/repos/fast/fast") await new Promise(r => setTimeout(r, 5));
      if (p === "/repos/slow/slow" || p === "/repos/fast/fast")
        return { full_name: p.slice("/repos/".length), default_branch: "main" };
      return [];
    };
    const f = new Function("state", "api", "showView", "$", "renderRepoDetail", "loadContents", "refreshNotifCount", "esc",
      srcOpenRepo + "\nreturn { a: openRepo('slow/slow'), b: openRepo('fast/fast') };");
    const { a, b } = await f(state, api, () => {}, () => view, () => {}, () => {}, () => {}, esc);
    await a; await b;
    await new Promise(r => setTimeout(r, 60)); // 等 slow 的迟到响应落地（守卫应拦截）
    return { finalRepo: state.repo.full_name, viewHtml: view.innerHTML };
  };
  const r = await race();
  check("ENG-6 [runtime] 连点两仓库：最终 state.repo 是后点开的 fast/slow 慢响应被丢弃",
    r.finalRepo === "fast/fast" && !r.viewHtml.includes("slow/slow"),
    JSON.stringify({ finalRepo: r.finalRepo, viewHasSlow: r.viewHtml.includes("slow/slow") }));

  // [runtime] openRepo 发起即递增代际（同步可观测）
  const bump = async () => {
    const state = { reqGen: 10, repo: null };
    const api = async () => { throw new Error("stop"); };
    try { await new Function("state", "api", "showView", "$", "renderRepoDetail", "loadContents", "refreshNotifCount", "esc",
      srcOpenRepo + "\nreturn openRepo('a/b');")(state, api, () => {}, () => ({ innerHTML: "" }), () => {}, () => {}, () => {}, esc); }
    catch {}
    return state.reqGen;
  };
  check("ENG-6 [runtime] openRepo 调用后 state.reqGen 已递增（10 → 11）", (await bump()) === 11, "");
  check("ENG-6 openRepo 源码 const gen = ++state.reqGen",
    /const gen = \+\+state\.reqGen/.test(srcOpenRepo), "");
}

/* ============ ENG-7：Release 行模板 data-rdel/data-rtag 经 esc（含双引号 tag 无注入） ============ */
{
  // [runtime] 取 loadReleases 内的真实模板行，用一个含双引号/尖括号的 tag 拼一次
  const m = srcLoadReleases.match(/const kind = x\.draft[\s\S]*?'<\/a><\/div><\/div>';/);
  check("ENG-7 [STRUCT] 能从 loadReleases 提取真实行模板（提取工具能力检查，不参与变异验证）", !!m, "", true);
  if (m) {
    const renderRow = new Function("x", "esc", "icon", "timeAgo", m[0]);
    const evil = 'v"><img src=x onerror=alert(1)>';
    const row = renderRow(
      { id: evil, tag_name: evil, name: "", draft: false, prerelease: false,
        author: { login: "" }, published_at: 0, assets: { length: 0 }, html_url: "https://e/x" },
      esc, () => "", () => "");
    check("ENG-7 [runtime] data-rdel 已过 esc：无裸 \"><img 注入",
      row.includes('data-rdel="v&quot;&gt;&lt;img') && !row.includes('"><img src=x'),
      row.slice(row.indexOf("data-rdel"), row.indexOf("data-rdel") + 60));
    check("ENG-7 [runtime] data-rtag（确认框回显用）同样已过 esc（引号不再逃逸属性）",
      row.includes('data-rtag="v&quot;&gt;&lt;img') && !row.includes('"><img src=x'), "");
  }
  check("ENG-7 行模板 data-rdel/data-rtag 均使用 esc(x.id)/esc(x.tag_name)",
    /data-rdel="' \+ esc\(x\.id\) \+ '" data-rtag="' \+ esc\(x\.tag_name\) \+ '"/.test(srcLoadReleases), "");
}

/* ============ ENG-8：只读降级下 legacy Token 迁移不删源（删源以持久化成功为前提） ============ */
{
  check("ENG-8 迁移后删 ghc_token 源带 !state.vaultReadOnly 前提条件",
    /if \(legacy && !state\.vaultReadOnly\) localStorage\.removeItem\('ghc_token'\)/.test(srcLoadAccounts), "");
  check("ENG-8 readOnlyToastExtra 有真实使用点（只读提示追加迁移 Token 去向说明）",
    /readOnlyToastExtra = '；旧版迁移的 Token 仍保存在本地/.test(srcLoadAccounts) &&
    /\+ readOnlyToastExtra, 'err'/.test(srcLoadAccounts), "");
}

/* ============ ENG-9：isValidProxy 白名单校验 + saveProxy 先 apply 成功才写盘 ============ */
{
  // [runtime] 非法串被拒、合法串放行
  if (!srcValidProxy || !srcSaveProxy) {
    check("ENG-9 [runtime] isValidProxy/saveProxy 源码存在（修复前产物无此函数 → 变异轮应红）",
      false, "isValidProxy=" + !!srcValidProxy + " saveProxy=" + !!srcSaveProxy);
  } else {
  const isValidProxy = eval("(function(){" + srcValidProxy + "; return isValidProxy; })()");
  const rejects = ["abc", "127.0.0.1:99999", "socks5://", "host:0", "host:65536", "host:1.2"];
  const accepts = ["1.2.3.4:8080", "socks5://h:1080", "host:1", "host:65535"];
  check("ENG-9 [runtime] isValidProxy 拒绝非法代理串（abc / 端口越界 / 纯 scheme）",
    rejects.every(v => isValidProxy(v) === false),
    rejects.filter(v => isValidProxy(v)).join(","));
  check("ENG-9 [runtime] isValidProxy 放行合法 host:port 与 scheme://host:port",
    accepts.every(v => isValidProxy(v) === true),
    accepts.filter(v => !isValidProxy(v)).join(","));

  // [runtime] saveProxy：applyProxy 失败({ok:false})时不写盘；成功才写盘
  const mkSave = (applyResult) => {
    let written = null;
    const fsStub = { writeFileSync: (p, v) => { written = v; } };
    const saveProxy = new Function("fs", "proxyFile", "applyProxy",
      srcSaveProxy + "\nreturn saveProxy;")(fsStub, () => "/fake/proxy.txt", async () => applyResult);
    return { run: (v) => saveProxy(v), get written() { return written; } };
  };
  const bad = mkSave({ ok: false, error: "代理格式无效" });
  const rBad = await bad.run("1.2.3.4:9999");
  check("ENG-9 [runtime] saveProxy 在 applyProxy 失败时不写盘（坏值不跨重启持久化）",
    rBad.ok === false && bad.written === null, JSON.stringify({ r: rBad, written: bad.written }));
  const good = mkSave({ ok: true, proxy: "1.2.3.4:8080" });
  await good.run("1.2.3.4:8080");
  check("ENG-9 [runtime] saveProxy 在 applyProxy 成功后才写盘（对照路径不回归）",
    good.written === "1.2.3.4:8080", String(good.written));
  check("ENG-9 桥内 applyProxy 自定义分支先校验 isValidProxy 再 setProxy",
    /if \(!isValidProxy\(v\)\)/.test(cjs) && /代理格式无效/.test(cjs), "");
  }
}

/* ============ ENG-10：超时清登记后的迟到 will-download 不静默落盘（消费 staleDownloadUntil + 通知渲染层） ============ */
{
  check("ENG-10 will-download 默认分支消费 staleDownloadUntil（迟到下载识别）",
    /if \(Date\.now\(\) < staleDownloadUntil\)/.test(cjs), "");
  check("ENG-10 迟到下载通过 executeJavaScript 通知渲染层 toast（窗口销毁场景 try/catch 静默）",
    /一个迟到的下载已保存到系统下载目录/.test(cjs) &&
    /executeJavaScript\("toast\(/.test(cjs), "");
  check("ENG-10 超时分支登记 staleDownloadUntil（约 130s 窗口）",
    /staleDownloadUntil = Date\.now\(\) \+ 130000/.test(cjs), "");
}

console.log("\n---- 结果: " + (mutPass + structPass) + " PASS / " + (mutFail + structFail) + " FAIL ----" +
  "（变异组 MUT: " + mutPass + " PASS / " + mutFail + " FAIL；结构组 STRUCT: " + structPass + " PASS / " + structFail + " FAIL）" +
  (isBackupRun ? " [AUDIT_TARGET=备份产物]" : " [当前产物]"));
process.exit((mutFail + structFail) ? 1 : 0);
