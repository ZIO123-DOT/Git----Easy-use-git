// 审查审计单测（QA Edward，零依赖，直接从 console.html 提取真实源码验证）
// 运行：node electron-app/tests/review-audit.test.mjs
// 说明：分两类用例——
//   [BUG-REPRO]  断言"当前带缺陷行为"确实存在（修复后应翻转断言）
//   [SAFE]       断言"已验证安全/正确"的关键点（修复重构时防回归）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// GC_HTML / GC_CJS / GC_DOC：可选覆盖点，用于把断言对着「修复前」的备份产物跑一遍，
// 验证新增的 FIX-xx 断言确实会红（证明它们能真正捕获回归）。
const html = fs.readFileSync(process.env.GC_HTML || path.resolve(here, "../console.html"), "utf8");
const cjsPath = process.env.GC_CJS || path.resolve(here, "../desktop.cjs");
const docPath = process.env.GC_DOC || path.resolve(here, "../../使用说明.txt");

// ---- 提取工具：花括号配对截取函数/常量源码 ----
function extractFn(marker) {
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("未找到 " + marker);
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error("花括号不配对: " + marker);
}
const srcDeleteModal = extractFn("function deleteModal(");
const srcLoadRuns = extractFn("async function loadRuns(");
const srcLoadCommits = extractFn("async function loadCommits(");
const srcLoadAccounts = extractFn("async function loadAccounts(");
const srcSaveAccounts = extractFn("function saveAccounts(");
const srcApi = extractFn("async function api(");
const srcEncPath = extractFn("function encPath(");
const srcUtf8ToB64 = extractFn("function utf8ToB64(");
const srcB64ToUtf8 = extractFn("function b64ToUtf8(");
const srcEnterShell = extractFn("function enterShell(");
const srcResetSession = extractFn("function resetSession(");
const srcConfirmModal = extractFn("function confirmModal(");
// icon 函数（内嵌图标表，整体提取即可运行）
const srcIcon = extractFn("function icon(");
// desktop.cjs 主进程源码（白名单/桥接断言用）
const srcPing = fs.readFileSync(cjsPath, "utf8");

// settings 页切换账号 handler（renderSettings 内 $$('#view-settings [data-act]') 块）
const iSetHandler = html.indexOf("$$('#view-settings [data-act]')");
if (iSetHandler < 0) throw new Error("未找到 settings data-act handler");
const iSetEnd = html.indexOf("\n  }));", iSetHandler);
const srcSetHandler = html.slice(iSetHandler, iSetEnd);

// GITLAB 适配器（与 gitlab-adapter.test.mjs 同法，但从 console.html 提取——测的是发布产物）
const gi = html.indexOf("const GITLAB = {");
let gdepth = 0, gend = -1;
for (let i = gi; i < html.length; i++) {
  if (html[i] === "{") gdepth++;
  else if (html[i] === "}") { gdepth--; if (gdepth === 0) { gend = i + 1; break; } }
}
const GITLAB = eval("(function(){" + html.slice(gi, gend) + "; return GITLAB; })()");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name, "->", detail); }
};

/* ============ 一、修复验证（原 BUG-REPRO 已翻转为防回归断言） ============ */

// BUG-A（已修复）：批量删除确认框在 state.user 为 null 时不再 TypeError
{
  const result = eval(`(function(){
    let outcome;
    const state = { user: null };
    let confirmCalled = false;
    const confirmModal = () => { confirmCalled = true; };
    const toast = () => {};
    ${srcDeleteModal}
    try { deleteModal([{ full_name: 'a/b' }, { full_name: 'c/d' }], null); outcome = 'no-throw'; }
    catch (e) { outcome = e.constructor.name + ': ' + e.message; }
    return { outcome, confirmCalled };
  })()`);
  check("BUG-A 修复：deleteModal 在 state.user=null 时不抛 TypeError",
    result.outcome === 'no-throw' && result.confirmCalled === true, JSON.stringify(result));
  check("BUG-A 回归：单仓库路径 need 取 full_name",
    eval(`(function(){
      const state = { user: null };
      let called = false;
      const confirmModal = (o) => { called = true; return o; };
      ${srcDeleteModal}
      deleteModal([{ full_name: 'a/b' }], null);
      return called;
    })()`) === true, "");
}

// BUG-B（已修复）：settings 切号统一走 enterShell → resetSession 全量清理
{
  check("BUG-B 修复：settings 切号 handler 调用 enterShell（全量清理）", /enterShell\(\)/.test(srcSetHandler), "");
  check("BUG-B 修复：handler 不再手抄局部清理清单", !/state\.repos = \[\]/.test(srcSetHandler), "");
  check("BUG-B 修复：切号后有用户反馈（toast）", /toast\(/.test(srcSetHandler), "");
}

// BUG-C（已修复）：icon 表补充 'x' 图标，错误 toast 正常渲染
{
  const iconFn = eval("(function(){" + srcIcon + "; return icon; })()");
  check("BUG-C 修复：icon('x') 有真实 path", /<path/.test(iconFn("x")), iconFn("x"));
  check("BUG-C 修复：icon('check') 有 path", /<path/.test(iconFn("check")), "");
  check("BUG-C 佐证：toast err 分支引用 'x'", /icon\(type === 'err' \? 'x'/.test(html), "");
}

// BUG-D（已修复）：loadRuns 补 reqGen 代际守卫
{
  check("BUG-D 修复：loadRuns 有 reqGen 守卫", /reqGen/.test(srcLoadRuns), "");
  check("BUG-D 修复：守卫语义正确（gen 不匹配即 return）", /gen !== state\.reqGen\) return/.test(srcLoadRuns), "");
  check("BUG-D 对照：loadCommits 也有 reqGen 守卫", /reqGen/.test(srcLoadCommits), "");
}

// BUG-E1（已修复）：GitLab 文件路径只编码一次——调用方 encPath 已逐段编码，translate 直接透传
{
  const r = GITLAB.translate("GET", "/repos/o/r/contents/src/a%20b.js?ref=main");
  check("BUG-E1 修复：含空格文件路径单次编码（%20 保持）", r.url.includes("/files/src/a%20b.js") && !r.url.includes("%25"), r.url);
  const r2 = GITLAB.translate("PUT", "/repos/o/r/contents/src/%E4%B8%AD%E6%96%87.js", { message: "m", content: "", branch: "main" });
  check("BUG-E1 修复：中文文件名单次编码（%E4 保持）", r2.url.includes("/files/src/%E4%B8%AD%E6%96%87.js") && !r2.url.includes("%25"), r2.url);
  const r3 = GITLAB.translate("DELETE", "/repos/o/r/git/refs/heads/feat%20x");
  check("BUG-E1 修复：删分支分支名单次编码", r3.url.endsWith("/repository/branches/feat%20x") && !r3.url.includes("%25"), r3.url);
  const r4 = GITLAB.translate("DELETE", "/repos/o/r/releases/v1.0");
  check("BUG-E1 对照：releases 删除路径仍正确", r4.url === "/projects/o%2Fr/releases/v1.0", r4.url);
}

// BUG-E2（已修复）：GitLab 嵌套组仓库——已知子资源词表切分，full_name 支持多段
{
  const r = GITLAB.translate("GET", "/repos/group/sub/repo");
  check("BUG-E2 修复：嵌套组仓库整段作为 full_name", r.url === "/projects/group%2Fsub%2Frepo", r.url);
  const r2 = GITLAB.translate("GET", "/repos/group/sub/repo/contents/README.md");
  check("BUG-E2 修复：嵌套组 + 子资源正确切分", r2.url === "/projects/group%2Fsub%2Frepo/repository/files/README.md", r2.url);
  const r3 = GITLAB.translate("GET", "/repos/o/r/contents/src/app.js?ref=main");
  check("BUG-E2 回归：两段式仓库行为不变", r3.url === "/projects/o%2Fr/repository/files/src/app.js?ref=main", r3.url);
  const r4 = GITLAB.translate("GET", "/repos/o/r/issues?state=open");
  check("BUG-E2 回归：issues 分支不受词表切分影响", r4.norm === "issues" && r4.url.includes("/issues?per_page=100&scope=all&state=opened"), r4.url);
  const r5 = GITLAB.translate("DELETE", "/repos/g1/g2/repo");
  check("BUG-E2 回归：DELETE 嵌套组仓库", r5.url === "/projects/g1%2Fg2%2Frepo", r5.url);
}

// BUG-F（已修复）：loadAccounts 检查 secrets-get 的 error 标志 → 只读降级
{
  check("BUG-F 修复：loadAccounts 检查 d.error", /d\.error/.test(srcLoadAccounts), "");
  check("BUG-F 修复：error 态置 vaultReadOnly", /vaultReadOnly = true/.test(srcLoadAccounts), "");
  check("BUG-F 修复：saveAccounts 在只读态拒绝落盘（数据丢失链的最后一道闸）",
    /vaultReadOnly[\s\S]{0,120}return/.test(srcSaveAccounts), srcSaveAccounts.slice(0, 200));
}

// BUG-G（已修复）：加密库读取成功后清理 localStorage 明文副本；保存失败不再回退落明文
{
  check("BUG-G 修复：loadAccounts 成功路径 removeItem('gc_accounts')",
    /removeItem\(['"]gc_accounts['"]\)/.test(srcLoadAccounts), "");
  // 原「BUG-G 佐证」断言的是「catch 分支仍保留明文回退」——它锁的是 C-06 的旧缺陷行为，
  // 与本轮「Token 明文不得落 localStorage」的正向要求直接冲突，故翻转（详见修复报告「改动过的既有断言」一节）。
  check("BUG-G 翻转（C-06）：secrets-set 失败时不再回退写 localStorage 明文",
    !/\.catch\(\(\) => \{ localStorage\.setItem\('gc_accounts'/.test(srcSaveAccounts), srcSaveAccounts.slice(-280));
  check("BUG-G 翻转（C-06）：保存失败改为 toast 明确提示",
    /Token 保存失败/.test(srcSaveAccounts) && /toast\(/.test(srcSaveAccounts), "");
  check("BUG-G 佐证：file: 协议分支仍落 localStorage（Edge/app 模式无加密后端，属已知非加密存储）",
    /location\.protocol === 'file:'\)\s*\{[\s\S]{0,260}localStorage\.setItem\('gc_accounts'/.test(srcSaveAccounts), "");
}

// BUG-H（已修复）：304 但缓存被 LRU 逐出时，去掉条件头重发一次而不是报 "HTTP 304"
{
  check("BUG-H 修复：304 未命中缓存时重发（delete If-None-Match + continue）",
    /304 && attempt === 0/.test(srcApi) && /delete headers\['If-None-Match'\]/.test(srcApi), "");
  check("BUG-H 修复：重发循环存在（attempt < 2）", /for \(let attempt = 0; attempt < 2/.test(srcApi), "");
}

/* ============ 二、已验证安全/正确（SAFE：重构时防回归） ============ */

// SAFE-1 esc() 覆盖 5 类 HTML 敏感字符
{
  const escLine = html.split("\n").find(l => l.startsWith("const esc ="));
  const esc = eval("(" + escLine.replace("const esc =", "").trim().replace(/;$/, "") + ")");
  check("SAFE-1 esc() 转义 &< >\" ' 全部五类",
    esc(`<a b="c">'&`) === "&lt;a b=&quot;c&quot;&gt;&#39;&amp;", esc(`<a b="c">'&`));
}
// SAFE-2 encPath 防目录穿越 + 逐段编码
{
  const encPath = eval("(function(){" + srcEncPath + "; return encPath; })()");
  let threw = false;
  try { encPath("a/../b"); } catch (e) { threw = true; }
  check("SAFE-2a encPath 拒绝 .. 穿越", threw, "");
  threw = false;
  try { encPath("a/./b"); } catch (e) { threw = true; }
  check("SAFE-2b encPath 拒绝 . 段", threw, "");
  check("SAFE-2c encPath 逐段编码保留 /",
    encPath("src/a b/中文.js") === "src/a%20b/%E4%B8%AD%E6%96%87.js", encPath("src/a b/中文.js"));
}
// SAFE-3 base64 编解码往返（含分块边界与多字节字符）
{
  const utf8ToB64 = eval("(function(){" + srcUtf8ToB64 + "; return utf8ToB64; })()");
  const b64ToUtf8 = eval("(function(){" + srcB64ToUtf8 + "; return b64ToUtf8; })()");
  const samples = ["hello", "中文测试🎉", "line1\nline2\ttab", "x".repeat(0x8000) + "边缘" + "y".repeat(0x8001)];
  let ok = samples.every(s => b64ToUtf8(utf8ToB64(s)) === s);
  check("SAFE-3 utf8ToB64/b64ToUtf8 往返一致（含 0x8000 分块边界/emoji）", ok, "");
}
// SAFE-4 runLimited 并发限流：结果有序、限流生效、错误逐项捕获
{
  const runLimited = eval("(function(){" + extractFn("async function runLimited(") + "; return runLimited; })()");
  let cur = 0, max = 0;
  const p = runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    cur++; max = Math.max(max, cur);
    await new Promise(r => setTimeout(r, 5));
    cur--;
    if (x === 4) throw new Error("boom-" + x);
    return x * 2;
  });
  const res = await p;
  check("SAFE-4a runLimited 结果按输入顺序", res.map(r => r.ok ? r.value : null).join(",") === "2,4,6,,10,12,14", JSON.stringify(res));
  check("SAFE-4b runLimited 并发不超过 limit", max <= 3, String(max));
  check("SAFE-4c runLimited 错误逐项捕获不中断批次", res[3].ok === false && res[3].error.message === "boom-4", "");
}
// SAFE-5 api() 缓存键含账号指纹（防跨账号缓存互踩）
{
  check("SAFE-5a cacheKey 前缀含 platform + token 末 8 位指纹",
    /acctFp = acct\.platform \+ '#' \+ \(acct\.token \|\| ''\)\.slice\(-8\)/.test(srcApi), "");
  check("SAFE-5b cacheKey 拼入 acctFp", /cacheKey = cacheable \? \(acctFp \+ ':' \+ url\)/.test(srcApi), "");
}
// SAFE-6 Gitee access_token 走 URL query（已认知风险，确认现状以便跟踪）
{
  check("SAFE-6 Gitee token 经 access_token= 拼 query（已知 P2 风险，记录现状）",
    /access_token=' \+ encodeURIComponent\(acct\.token\)/.test(srcApi), "");
}
// SAFE-7 confirmModal 列表项经 esc 转义（防仓库名 XSS）
{
  check("SAFE-7 confirmModal 的 list 项经过 esc()",
    /opts\.list\.map\(n => '<div>' \+ esc\(n\) \+ '<\/div>'\)/.test(srcConfirmModal), "");
}
// SAFE-8 主进程 secrets-set 卫生守卫（desktop.cjs）
{
  const cjs = srcPing;
  check("SAFE-8a secrets-set 拒绝畸形 body（400）", /malformed body/.test(cjs) && /400/.test(cjs), "");
  check("SAFE-8b secrets-set 写前留 .bak", /copyFileSync\(secretsFile\(\), secretsFile\(\) \+ "\.bak"\)/.test(cjs), "");
  check("SAFE-8c POST 超 2MB 拒绝（413）", /413/.test(cjs), "");
  check("SAFE-8d secrets-get 损坏库返回 error 态而非空库", /error: true/.test(cjs), "");
  check("SAFE-8e bridge 鉴权：无 Origin 头的本机请求仍需 tk 令牌", /searchParams\.get\("tk"\) === bridgeToken/.test(cjs), "");
}

// —— 第二轮审阅修复锁定：Gitee 登录 / 通知角标代际 / GitLab 搜索排序 ——
{
  check("R2-1 修复：tryLogin 对 gitee 追加 access_token query", /platform === 'gitee'\) loginUrl \+= \?access_token=/.test(html) || /platform === 'gitee'/.test(html) && /access_token=' \+ encodeURIComponent\(token\)/.test(html), "");
  check("R2-2 修复：enterShell 中 loadRepos 先于 refreshNotifCount（代际不自相残杀）",
    /loadRepos\(\); \/\/ 先启动 loadRepos[\s\S]{0,80}refreshNotifCount\(\);/.test(html), "");
  check("R2-3 修复：GitLab 搜索排序用 star_count（合法值）",
    /order_by=star_count/.test(html) && !/order_by=stars/.test(html), "");
  check("R2-4 修复：state 字面量声明 notifCount", /notifCount: 0/.test(html), "");
  check("R2-5 修复：ping 探测按平台传 host（主进程白名单校验；2026-09-15 GitCode 域迁移 api.gitcode.com）",
    /body: JSON\.stringify\(\{ host \}\)/.test(html) && /PING_ALLOW/.test(srcPing) && /["']api\.gitcode\.com["']\s*:\s*"https:\/\/api\.gitcode\.com/.test(srcPing), "");
}

/* ============ 三、本轮全量修复回归断言（FIX-xx） ============ */
// 每个 FIX 断言都可对着「修复前」的备份产物跑红（GC_HTML/GC_CJS/GC_DOC 指向 .backup-before-fullfix-*）
const srcCjs = srcPing;
const doc = fs.readFileSync(docPath, "utf8");
const mergePy = fs.readFileSync(path.resolve(here, "../../merge_parts.py"), "utf8");
const srcOpenRepo = extractFn("async function openRepo(");
const srcLoadBranches = extractFn("async function loadBranches(");
const srcDoSearch = extractFn("async function doSearch(");
const srcSaveAccountsFull = extractFn("function saveAccounts(");
const srcRequireScopes = extractFn("function requireScopes(");
const srcUpdateRate = extractFn("function updateRate(");
const iDelHandler = html.indexOf("$$('#view-settings [data-del]')");
const iDelEnd = html.indexOf("\n  }));", iDelHandler);
const srcSetDel = html.slice(iDelHandler, iDelEnd);

// —— C-01：GitLab 新建文件走 POST（有 sha 才 PUT）；Gitee/GitCode 同构改写 ——
{
  const rNew = GITLAB.translate("PUT", "/repos/o/r/contents/new.md", { message: "m", content: "QQ==", branch: "main" });
  check("FIX-01a GitLab 新建文件（无 sha）→ POST",
    rNew.method === "POST" && rNew.url === "/projects/o%2Fr/repository/files/new.md", JSON.stringify({ url: rNew.url, method: rNew.method }));
  const rUpd = GITLAB.translate("PUT", "/repos/o/r/contents/exists.md", { message: "m", content: "QQ==", branch: "main", sha: "deadbeef" });
  check("FIX-01b GitLab 更新文件（有 sha）→ PUT + last_commit_id",
    rUpd.method === "PUT" && rUpd.body.last_commit_id === "deadbeef", JSON.stringify(rUpd.body));
  check("FIX-01c translate() 接收并透传 hit.method（关键陷阱）",
    /if \(hit\.method\) method = hit\.method/.test(html), "");
  check("FIX-01d Gitee/GitCode 无 sha 写文件同构改写为 POST（api 层）",
    /acct\.platform === 'gitee' \|\| acct\.platform === 'gitcode'/.test(srcApi) &&
    /method = 'POST'/.test(srcApi) && /contents/.test(srcApi), "");
  check("FIX-01e uploadOne 覆盖重试不再只认 422（改按能否取到 sha 判断，跨平台成立）",
    !/e\.status === 422 && overwrite/.test(html) &&
    /if \(overwrite\) \{[\s\S]{0,160}ex = await api\('GET'/.test(html), "");
}

// —— C-02：GitLab 嵌套组仓库收藏/取消收藏 ——
{
  const r1 = GITLAB.translate("PUT", "/user/starred/group/sub/repo");
  check("FIX-02a 嵌套组收藏 → /star", r1.url === "/projects/group%2Fsub%2Frepo/star", r1.url);
  const r2 = GITLAB.translate("DELETE", "/user/starred/group/sub/repo");
  check("FIX-02b 嵌套组取消收藏 → /unstar", r2.url === "/projects/group%2Fsub%2Frepo/unstar", r2.url);
  const r3 = GITLAB.translate("PUT", "/user/starred/o/r");
  check("FIX-02c 两段式收藏回归不变", r3.url === "/projects/o%2Fr/star", r3.url);
  const r4 = GITLAB.translate("GET", "/user/starred?per_page=100&page=2");
  check("FIX-02d 收藏列表仍走列表端点（未被收藏分支截胡）", r4.norm === "repos" && r4.url.startsWith("/projects?starred=true"), r4.url);
}

// —— C-03：仓库名撞子资源词表时的路由（验收表） ——
{
  const cases = [
    ["GET", "/repos/me/issues", "/projects/me%2Fissues"],
    ["GET", "/repos/me/contents", "/projects/me%2Fcontents"],
    ["GET", "/repos/me/branches", "/projects/me%2Fbranches"],
    ["GET", "/repos/me/commits", "/projects/me%2Fcommits"],
    ["GET", "/repos/me/pulls", "/projects/me%2Fpulls"],
    ["GET", "/repos/me/releases", "/projects/me%2Freleases"],
    ["GET", "/repos/o/r/contents/src/app.js?ref=main", "/projects/o%2Fr/repository/files/src/app.js?ref=main"],
    ["GET", "/repos/group/sub/repo/contents/README.md", "/projects/group%2Fsub%2Frepo/repository/files/README.md"],
    ["DELETE", "/repos/a/b/c/d", "/projects/a%2Fb%2Fc%2Fd"],
    ["GET", "/repos/o/r/labels", "/projects/o%2Fr/labels"],
    ["DELETE", "/repos/o/r/git/refs/heads/feat%20x", "/projects/o%2Fr/repository/branches/feat%20x"],
  ];
  for (const [m, p, exp] of cases) {
    const got = GITLAB.translate(m, p).url;
    check("FIX-03 词表撞名路由 " + m + " " + p, got === exp, "got=" + got + " exp=" + exp);
  }
}

// —— C-04：requireScopes 真实现（GitHub 缺 delete_repo 时返回真实提示；其余平台诚实降级为 null） ——
{
  const run = (platform, scopes) => eval("(function(){ const state = { tokenScopes: " + JSON.stringify(scopes) +
    " }; const activeAccount = () => ({ platform: " + JSON.stringify(platform) + " }); " + srcRequireScopes + "; return requireScopes(); })()");
  check("FIX-04a github 缺 delete_repo → 返回真实提示串", /delete_repo/.test(run("github", ["repo"]) || ""), run("github", ["repo"]));
  check("FIX-04b github 含 delete_repo → null", run("github", ["repo", "delete_repo"]) === null, "");
  check("FIX-04c github 未收到 scope 头 → null（不误报）", run("github", null) === null, "");
  check("FIX-04d 非 github 平台 → null（诚实降级，非空壳）", run("gitlab", ["api"]) === null && run("gitee", ["api"]) === null, "");
  check("FIX-04e updateRate 捕获 X-OAuth-Scopes 到 state", /X-OAuth-Scopes/.test(srcUpdateRate) && /state\.tokenScopes/.test(srcUpdateRate), "");
  check("FIX-04f 不再是恒 null 的空壳", !/function requireScopes\(\) \{ return null; \}/.test(html), "");
}

// —— C-05：applyProxy await + 仅成功置态；桥按结果回 ok/error ——
{
  check("FIX-05a applyProxy 改 async 且 await setProxy",
    /const applyProxy = async/.test(srcCjs) && /await session\.defaultSession\.setProxy/.test(srcCjs), "");
  check("FIX-05b 仅 await 成功后才更新 currentProxy",
    /await session\.defaultSession\.setProxy[\s\S]{0,420}currentProxy = v \|\| "system"/.test(srcCjs), "");
  check("FIX-05c loadProxy/saveProxy 改 async 并 await applyProxy",
    /const loadProxy = async/.test(srcCjs) && /const saveProxy = async/.test(srcCjs) && /await applyProxy\(/.test(srcCjs), "");
  check("FIX-05d setproxy 桥按结果回 {ok:false,error}",
    /setproxy: async[\s\S]{0,700}ok: false, error/.test(srcCjs), "");
  check("FIX-05e 前端 setproxy 调用据 ok 决定文案（不再无条件说已生效）",
    /代理更新失败/.test(html) && /代理保存失败/.test(html) && /代理应用失败/.test(html), "");
}

// —— C-08：切号竞态守卫（四处） ——
{
  check("FIX-08a openRepo 补 reqGen 守卫且写回在守卫后（发起即递增代际——旧的「只捕获」正是 ENG-6 缺陷）",
    /const gen = \+\+state\.reqGen/.test(srcOpenRepo) &&
    (srcOpenRepo.match(/gen !== state\.reqGen\) return/g) || []).length >= 2 &&
    !/state\.(repo|branches) = await api/.test(srcOpenRepo), "");
  check("FIX-08b loadBranches 赋值移到守卫之后",
    /if \(gen !== state\.reqGen\) return;[\s\S]{0,90}state\.branches = branches/.test(srcLoadBranches) && !/state\.branches = await api/.test(srcLoadBranches), "");
  check("FIX-08c doSearch 补 reqGen 守卫",
    /const gen = state\.reqGen/.test(srcDoSearch) && (srcDoSearch.match(/gen !== state\.reqGen\)/g) || []).length >= 2, "");
  check("FIX-08d enterShell 内 /user 回调补 reqGen 守卫",
    /const gen = state\.reqGen[\s\S]{0,140}api\('GET', '\/user'\)\.then\(u => \{[\s\S]{0,160}gen !== state\.reqGen\) return/.test(srcEnterShell), "");
}

// —— C-09：解绑最后一个账号 → 回登录页 ——
{
  check("FIX-09 解绑后无账号则 logout（不再困在空壳）",
    /removeAccount\(i\)[\s\S]{0,200}if \(!state\.accounts\.length\)[\s\S]{0,80}logout\(/.test(srcSetDel), "");
}

// —— B-2：下载按钮改走主进程桥接（白名单 + will-download 落盘） ——
{
  // 收尾轮：download 桥改为 async（先弹另存为），故签名断言同步为 async（旧签名 lock 已随实现演进更新）
  check("FIX-B2a 主进程 download 桥（async）+ host 白名单",
    /download: async \(\{ u, res \}\)/.test(srcCjs) && /DOWNLOAD_ALLOW/.test(srcCjs) && /window\.webContents\.downloadURL\(target\.href\)/.test(srcCjs), "");
  check("FIX-B2b 非白名单/非 https 回 400", /url not allowed/.test(srcCjs), "");
  check("FIX-B2c 挂 will-download 并 setSavePath（实测无监听不会自动落盘）",
    /will-download/.test(srcCjs) && /item\.setSavePath/.test(srcCjs), "");
  check("FIX-B2d 渲染层改走桥接（去掉裸 download 属性）",
    /id="btn-download"/.test(html) && !/download="' \+ esc\(f\.name\)/.test(html) && /bridgeURL\('download'/.test(html), "");
}

// —— CSP-Gitee / CSP-GitCode：头像域白名单 ——
{
  check("FIX-CSPa img-src 含 portrait.gitee.com", /https:\/\/portrait\.gitee\.com/.test(srcCjs), "");
  check("FIX-CSPb img-src 含 cdn-img.gitcode.com", /https:\/\/cdn-img\.gitcode\.com/.test(srcCjs), "");
}

// —— C-10 / C-11 / C-12 / C-13 / C-14 / B-6 / 文档口径 / 上传文案 / 构建 ——
{
  check("FIX-C10 executeJavaScript 加 .catch（无未处理拒绝噪声）",
    /void window\.webContents\.executeJavaScript\([\s\S]{0,140}\)\.catch\(\(\) => \{\}\)/.test(srcCjs), "");
  check("FIX-C11 已删除模块级 let server = null（无被遮蔽死变量）",
    !/^let server = null;$/m.test(srcCjs), "");
  check("FIX-C12 renderLoginPlatforms 同步 state.loginPlatform",
    /function renderLoginPlatforms\(\)\{[\s\S]{0,220}state\.loginPlatform = loginPlatform/.test(html), "");
  check("FIX-C13 已删除零调用的 pyApi()", !/function pyApi\(/.test(html), "");
  check("FIX-C14 collectDropped 返回完整 {files,overflow,ignored}，超量改走确认框（不再收集阶段静默截断）",
    /return \{ files: out, overflow, ignored \}/.test(html) && /function openUploadConfirm\(/.test(html) &&
    /记住我的选择/.test(html) && /超过单次上限/.test(html) && !/已截断：拖入条目过多/.test(html), "");
  check("FIX-B6 切换筛选/搜索词时清空 selected",
    /state\.filter = c\.dataset\.filter;\s*state\.selected\.clear\(\);/.test(html) &&
    /search\.addEventListener\('change', \(\) => \{ state\.selected\.clear\(\);/.test(html), "");
  check("FIX-DOC1 登录副标题统一为四平台", /GitHub \/ GitLab \/ Gitee \/ GitCode/.test(html), "");
  check("FIX-DOC2 使用说明平台清单含 Gitee", /GitLab \/ Gitee \/ GitCode/.test(doc), "");
  check("FIX-DOC3 使用说明换机迁移口径修正（账号与 Token 均不随文件夹迁移）",
    /不随文件夹走|不会跟着迁移/.test(doc) && !/账号列表保留/.test(doc), "");
  check("FIX-UP1 上传覆盖文案与实际一致（不再「否则跳过」）",
    !/否则跳过/.test(html) && /不勾选时，云端同名文件会上传失败/.test(html), "");
  check("FIX-MERGE merge_parts.py 一次写两个位置",
    /electron-app/.test(mergePy) && /github-console\.html/.test(mergePy) && /console\.html/.test(mergePy), "");
  check("FIX-SET1 settings 关于口径含四平台", /GitHub \/ GitLab \/ Gitee \/ GitCode/.test(html), "");
  if (!process.env.GC_HTML) {
    const rootHtml = fs.readFileSync(path.resolve(here, "../../github-console.html"), "utf8");
    check("FIX-MERGE2 根目录与 electron-app 两份产物逐字节一致", rootHtml === html, "");
  }
}

/* ============ 四、收尾轮：C-03 彻底消歧（fullName 确定性切分）+ B-2 另存为 ============ */
// 同法可对备份产物跑红：GC_HTML/GC_CJS 指向 .backup-before-fullfix-*
{
  // —— C-03：api 第 4 参数 opts.fullName 透传到 translate；命中前缀则确定性切分 ——
  check("FIX-15a api() 增加第 4 参数 opts，并把 opts.fullName 透传给 GITLAB.translate",
    /async function api\(method, path, body, opts\)/.test(srcApi) &&
    /GITLAB\.translate\(method, path, body, opts && opts\.fullName\)/.test(srcApi), "");
  check("FIX-15b GITLAB.translate 新增第 4 参数 fullName",
    /translate\(method, path, body, fullName\)/.test(html), "");
  check("FIX-15c 命中 /repos/<fullName> 前缀时走确定性切分（跳过词表启发式）",
    /const prefix = '\/repos\/' \+ fullName/.test(html) &&
    /p === prefix \|\| p\.startsWith\(prefix \+ '\/'\)/.test(html) &&
    /full = fullName;/.test(html), "");

  // 验收反例：带 fullName 后必须按「仓库 full_name 长度」精确切开（无 fullName 时启发式会切错）
  const cases15 = [
    ["GET", "/repos/o/r/contents/contents", "o/r", "/projects/o%2Fr/repository/files/contents"],
    ["GET", "/repos/o/r/contents/branches", "o/r", "/projects/o%2Fr/repository/files/branches"],
    ["GET", "/repos/o/r/commits/issues", "o/r", "/projects/o%2Fr/commits/issues"],
    ["GET", "/repos/g1/g2/contents/issues", "g1/g2", "/projects/g1%2Fg2/repository/files/issues"],
    ["GET", "/repos/g1/g2/repo/contents/README.md", "g1/g2/repo", "/projects/g1%2Fg2%2Frepo/repository/files/README.md"],
    ["GET", "/repos/o/r", "o/r", "/projects/o%2Fr"],
    // 仓库名本身等于子资源词：左→右启发式（旧备份）会把仓库名截断为 'me'/'o'，确定性切分则正确
    ["GET", "/repos/me/issues", "me/issues", "/projects/me%2Fissues"],
    ["GET", "/repos/o/contents", "o/contents", "/projects/o%2Fcontents"],
  ];
  for (const [m, p, fn, exp] of cases15) {
    const got = GITLAB.translate(m, p, undefined, fn).url;
    check("FIX-15d fullName 确定性切分 " + m + " " + p + " (full=" + fn + ")", got === exp, "got=" + got + " exp=" + exp);
  }
  // 未传 fullName 时保持自右向左启发式兜底（老行为回归不变）
  check("FIX-15e 未传 fullName 时保持启发式兜底（/repos/o/r/contents/src/app.js 仍正确）",
    GITLAB.translate("GET", "/repos/o/r/contents/src/app.js?ref=main").url === "/projects/o%2Fr/repository/files/src/app.js?ref=main", "");
  // 同一路径：不传 fullName（启发式）会切错、传 fullName 才切对 —— 证明第 4 参数确有必要（非画蛇添足）
  check("FIX-15h 不传 fullName 会切错、传 fullName 才切对（证明确定性切分确有必要）",
    GITLAB.translate("GET", "/repos/o/r/contents/contents").url !== "/projects/o%2Fr/repository/files/contents" &&
    GITLAB.translate("GET", "/repos/o/r/contents/contents", undefined, "o/r").url === "/projects/o%2Fr/repository/files/contents", "");
  // 仓库上下文调用点均已补 opts.fullName（openRepo/loadContents/…/uploadOne 等）
  const fnArgs = (html.match(/\{ fullName/g) || []).length;
  check("FIX-15f 仓库上下文调用点统一传 opts.fullName（覆盖数 ≥ 22）", fnArgs >= 22, "fullName args=" + fnArgs);
  check("FIX-15g openRepo 用入参 fullName（非 state.repo，避免上一个仓库污染）",
    /api\('GET', '\/repos\/' \+ fullName, undefined, \{ fullName \}\)/.test(srcOpenRepo), "");

  // —— B-2：主进程「另存为」对话框 + 如实回结果（不再无条件报成功） ——
  check("FIX-B2e download 桥先 await dialog.showSaveDialog（取消不发请求，回 canceled）",
    /download: async[\s\S]{0,2200}showSaveDialog/.test(srcCjs) && /canceled: true/.test(srcCjs), "");
  check("FIX-B2f 确认后 downloadURL，并按 state 如实回结果（含超时兜底）",
    /window\.webContents\.downloadURL\(target\.href\)/.test(srcCjs) &&
    /Promise\.race/.test(srcCjs) && /download timeout|120000/.test(srcCjs) &&
    /state === "completed"/.test(srcCjs) && /state === "cancelled"/.test(srcCjs), "");
  check("FIX-B2g will-download 用 pendingDownload.savePath setSavePath，done 时 resolve 回桥",
    /pendingDownload/.test(srcCjs) && /pd\.savePath/.test(srcCjs) && /pd\.resolve/.test(srcCjs) && /item\.setSavePath\(savePath\)/.test(srcCjs), "");
  check("FIX-B2h 渲染层据真实结果提示（已保存到<路径>；取消不报错）",
    /已保存到/.test(html) && /d\.canceled/.test(html), "");
  check("FIX-B2i host 白名单未放松（仍限四平台下载域 + 强制 https）",
    /DOWNLOAD_ALLOW = \["github\.com", "githubusercontent\.com", "gitlab\.com", "gitee\.com", "gitcode\.com"\]/.test(srcCjs) &&
    /target\.protocol !== "https:"/.test(srcCjs) && /url not allowed/.test(srcCjs), "");
}

/* ============ 五、QA 复验修正轮：QA-N1（doSearch 守卫拦截时复位 state.searching） ============ */
// 真实性驱动：注入最小依赖运行 doSearch 本体，模拟「await 期间别的 loader 递增 reqGen」→ 守卫拦截。
{
  const driveDoSearch = async (src, bumpDuringAwait) => {
    const fn = new Function(
      "state", "api", "$", "toast", "esc", "renderSearchResults", "bindSearchResults",
      src + "\nreturn doSearch();",
    );
    const state = { reqGen: 5, searching: true, searchQuery: "q", searchResults: [] };
    const $ = () => ({ value: "q", innerHTML: "" });
    const api = async () => { if (bumpDuringAwait) state.reqGen = 99; return { items: [] }; };
    await fn(state, api, $, () => {}, (s) => String(s), () => "", () => {});
    return state;
  };

  const guarded = await driveDoSearch(srcDoSearch, true);
  check("FIX-16a QA-N1 修复：doSearch 被守卫拦截时复位 state.searching（不再永久卡「搜索中…」）",
    guarded.searching === false && guarded.reqGen === 99, JSON.stringify(guarded));
  const normal = await driveDoSearch(srcDoSearch, false);
  check("FIX-16b QA-N1 对照：doSearch 正常完成路径仍复位 searching",
    normal.searching === false, JSON.stringify(normal));

  // 敏感性证明：抹掉新增的复位语句（还原为「修复前形态」）→ searching 永久卡 true，证明该语句是修复关键
  const mutant = srcDoSearch.replace(/\{ state\.searching = false; return; \}/g, "{ return; }");
  const mutantRun = await driveDoSearch(mutant, true);
  check("FIX-16c QA-N1 敏感性：去掉复位语句后 searching 卡 true（断言确能捕获该缺陷）",
    mutant !== srcDoSearch && mutantRun.searching === true, "mutantChanged=" + (mutant !== srcDoSearch) + " " + JSON.stringify(mutantRun));
}

console.log("\n---- 结果: " + pass + " PASS / " + fail + " FAIL ----");
process.exit(fail ? 1 : 0);
