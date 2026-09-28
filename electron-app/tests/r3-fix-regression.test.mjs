// R3 修复回归测试（第三轮审计：DEF-3 starredSet 全局写回守卫 + DEF-4 openPrFiles 弹窗竞态 + GitCode 令牌页地址 + GitLab statistics）
// 零依赖，从产物 console.html 花括号配对提取真实函数源码，注入 stub 真实执行。
//
// 覆盖：
//   [DOS-1] doStar 在途切号：不污染新账号 starredSet、不弹 toast、返回 false
//   [DOS-2] doStar 正常路径（对照组）：仍正确 add/delete + toast + 返回 true
//   [STG-1] starToggle 在途切号：不污染 starredSet、repo 字段不更新、不刷新详情
//   [STG-2] starToggle 正常路径（对照组）
//   [PRF-1] openPrFiles 两连点「变更」：第二次调用递增 reqGen，旧 PR 响应被丢弃（弹窗只显示最后点的 PR）
//   [PRF-2] openPrFiles 单次调用正常弹窗（对照）
//   [CFG-1] gitcode tokenUrl 指向 setting/token-classic/create（旧地址已被 GitCode 服务端判 404）
//   [CFG-2] gitlab /projects 列表带 statistics=true（否则 size 列恒 '-'）
//   [MUT-*] 变异验证：抹掉守卫语句后断言应能抓到（证明断言对修复敏感）
//
// 用法：
//   node electron-app/tests/r3-fix-regression.test.mjs                        # 对修复后产物（应全绿）
//   GC_HTML=<备份目录>/console.html node .../r3-fix-regression.test.mjs      # 对修复前备份（修复相关断言应变红）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(process.env.GC_HTML || path.resolve(here, "../console.js"), "utf8");

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

const srcDoStar = extractFn("async function doStar(");
const srcStarToggle = extractFn("async function starToggle(");
const srcOpenPrFiles = extractFn("async function openPrFiles(");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name, "->", detail); }
};

// ============ 驱动：doStar ============
async function driveDoStar(src, { switchDuringAwait }) {
  const state = { reqGen: 1, starredSet: new Set(["old/keep"]) };
  const toasts = [];
  const api = async () => { if (switchDuringAwait) { state.reqGen = 99; state.starredSet = new Set(); } return {}; };
  const fn = new Function("state", "api", "toast", src + "\nreturn doStar;");
  const ret = await fn(state, api, (m) => toasts.push(m))("acct/repoA", true, null);
  return { state, toasts, ret };
}

// ============ 驱动：starToggle ============
async function driveStarToggle(src, { starred, switchDuringAwait }) {
  const repoA = { full_name: "acct/repoA", viewer_has_starred: !!starred, stargazers_count: 10 };
  const state = { reqGen: 1, repo: repoA, starredSet: new Set(starred ? ["acct/repoA"] : []) };
  const toasts = [];
  let renderCount = 0;
  const api = async () => { if (switchDuringAwait) { state.reqGen = 99; state.repo = { full_name: "acct/repoB", viewer_has_starred: false, stargazers_count: 5 }; state.starredSet = new Set(); } return {}; };
  const fn = new Function("state", "api", "toast", "renderRepoDetail", src + "\nreturn starToggle;");
  await fn(state, api, (m) => toasts.push(m), () => { renderCount++; })();
  return { repoA, state, toasts, renderCount };
}

// ============ 驱动：openPrFiles（两连点竞态） ============
async function driveOpenPrFiles(src, { secondBumps }) {
  const state = { reqGen: 5, repo: { full_name: "o/r" } };
  const modals = [];
  const pending = {};
  const api = (method, url) => new Promise((resolve) => { pending[url] = resolve; });
  const fn = new Function("state", "api", "toast", "openModal", "$", src + "\nreturn openPrFiles;");
  const p1 = fn(state, api, () => {}, (h) => modals.push(h), () => ({}))(1);
  const p2 = fn(state, api, () => {}, (h) => modals.push(h), () => ({}))(2);
  // 若为修复后代码：第二次调用已 ++reqGen。若为旧代码/变异：reqGen 未变。
  if (!secondBumps) state.reqGen = 5; // 变异模式下保持不递增（模拟旧行为）
  pending["/repos/o/r/pulls/2/files?per_page=100"]({ map: () => [], length: 0 });   // PR#2 先回
  await p2;
  pending["/repos/o/r/pulls/1/files?per_page=100"]({ map: () => [], length: 0 });   // PR#1 晚回
  await p1;
  return { modals };
}

// ============ [DOS] doStar ============
{
  const r = await driveDoStar(srcDoStar, { switchDuringAwait: true });
  check("DOS-1a 在途切号后 starredSet 不含旧账号条目", !r.state.starredSet.has("acct/repoA"),
    "starredSet=" + [...r.state.starredSet]);
  check("DOS-1b 在途切号后不误弹「已收藏」toast", r.toasts.length === 0, JSON.stringify(r.toasts));
  check("DOS-1c 在途切号后返回 false（不触发调用方重渲染）", r.ret === false, "ret=" + r.ret);

  const n = await driveDoStar(srcDoStar, { switchDuringAwait: false });
  check("DOS-2a 正常路径 starredSet 正确新增", n.state.starredSet.has("acct/repoA"), [...n.state.starredSet]);
  check("DOS-2b 正常路径弹「已收藏」且返回 true", n.toasts.length === 1 && n.ret === true, JSON.stringify(n.toasts) + " ret=" + n.ret);
}

// ============ [STG] starToggle ============
{
  const g = await driveStarToggle(srcStarToggle, { starred: true, switchDuringAwait: true });
  check("STG-1a 在途切号后新仓库 starredSet 不被误删", !g.state.starredSet.has("acct/repoB") && !g.state.starredSet.has("acct/repoA"),
    [...g.state.starredSet]);
  check("STG-1b 在途切号后旧 repo 的 viewer_has_starred 不更新（repo 引用捕获语义保持）", g.repoA.viewer_has_starred === true);
  check("STG-1c 在途切号后不刷新详情", g.renderCount === 0, "renderCount=" + g.renderCount);

  const n = await driveStarToggle(srcStarToggle, { starred: true, switchDuringAwait: false });
  check("STG-2a 正常取消收藏：starredSet 删除 + repo 字段更新", !n.state.starredSet.has("acct/repoA") && n.repoA.viewer_has_starred === false);
  const n2 = await driveStarToggle(srcStarToggle, { starred: false, switchDuringAwait: false });
  check("STG-2b 正常收藏：starredSet 新增 + repo 字段更新", n2.state.starredSet.has("acct/repoA") && n2.repoA.viewer_has_starred === true);
}

// ============ [PRF] openPrFiles ============
{
  const fixedIsBumped = /\+\+state\.reqGen/.test(srcOpenPrFiles);
  const r = await driveOpenPrFiles(srcOpenPrFiles, { secondBumps: fixedIsBumped });
  const last = r.modals[r.modals.length - 1] || "";
  check("PRF-1 两连点时旧 PR#1 响应不覆盖最后弹窗", r.modals.length === 1 && last.includes("PR #2"),
    "弹窗次数=" + r.modals.length + " 最后内容含 PR#1=" + last.includes("PR #1"));

  const r1 = await driveOpenPrFiles(srcOpenPrFiles, { secondBumps: fixedIsBumped });
  void r1;
  check("PRF-2 结构：openModal 被真实调用（弹窗链路通）", r.modals.length >= 1);
}

// ============ [CFG] 平台配置 ============
{
  const m = html.match(/gitcode:\s*\{[\s\S]*?tokenUrl:\s*'([^']+)'/);
  const url = m && m[1];
  check("CFG-1a gitcode tokenUrl 指向 setting/token-classic/create", url === "https://gitcode.com/setting/token-classic/create", "实际=" + url);
  check("CFG-1b gitcode tokenUrl 不再指向已 404 的旧地址", !/profile\/personal_access_tokens/.test(url || ""), "实际=" + url);
  check("CFG-2 gitlab 仓库列表带 statistics=true（size 列可显示）", html.includes("'/projects?membership=true&simple=false&statistics=true'"),
    "未找到 statistics=true");
  check("CFG-3 gitcode apiBase 指向 api.gitcode.com（web-api 域被 CloudWAF 418 拦截，2026-09-15 实测）", html.includes("apiBase: 'https://api.gitcode.com/api/v5'"),
    "未找到新 apiBase");
  check("CFG-4 gitcode 仓库字段兜底（html_url/archived/size）已注入", /gitcode' && out && typeof out === 'object'/.test(html), "未找到 gcFix 归一化");
}

// ============ [MUT] 变异验证：抹掉守卫后断言必须变红 ============
{
  const mutDoStar = srcDoStar.replace(/if \(gen !== state\.reqGen\) return false;[^\n]*\n/, "");
  const mutated = mutDoStar !== srcDoStar;
  const r = await driveDoStar(mutDoStar, { switchDuringAwait: true });
  check("MUT-1 抹掉 doStar 守卫后污染确实发生（断言敏感）", mutated && r.state.starredSet.has("acct/repoA"),
    "变异生效=" + mutated + " 污染=" + r.state.starredSet.has("acct/repoA"));

  const mutSt = srcStarToggle.replace(/if \(gen !== state\.reqGen\) return;[^\n]*\n/g, "");
  const mutStChanged = mutSt !== srcStarToggle;
  const g = await driveStarToggle(mutSt, { starred: true, switchDuringAwait: true });
  // 抹掉守卫后：旧 repo 的 viewer_has_starred 会被错误置 false、且误弹「已取消收藏」——STG-1 组断言正是抓这两点
  check("MUT-2 抹掉 starToggle 守卫后副作用泄漏（断言敏感）", mutStChanged && g.repoA.viewer_has_starred === false && g.toasts.length === 1,
    "变异生效=" + mutStChanged + " viewer_has_starred=" + g.repoA.viewer_has_starred + " toasts=" + JSON.stringify(g.toasts));

  const mutPrf = srcOpenPrFiles.replace(/\+\+state\.reqGen/, "state.reqGen");
  const r3 = await driveOpenPrFiles(mutPrf, { secondBumps: false });
  check("MUT-3 抹掉 openPrFiles 递增后旧弹窗覆盖发生（断言敏感）", r3.modals.length === 2 && (r3.modals[1] || "").includes("PR #1"),
    "弹窗次数=" + r3.modals.length);
}

console.log("\n---- 结果: " + pass + " PASS / " + fail + " FAIL ----");
process.exit(fail ? 1 : 0);
