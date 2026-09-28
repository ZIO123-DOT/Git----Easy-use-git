// 修复回归测试（FIX3 轮）
// 覆盖三处修复：
//   FIX3-1  GitLab 删除文件不再携带 last_commit_id（blob SHA 传错会导致 400）
//   FIX3-2  Gitee/GitCode 建/删分支改写为其 /branches 端点（原直发 GitHub /git/refs → 404）
//   FIX3-3  解绑当前活跃账号走 enterShell 全量重置（原只清 state.user → 跨账号串号）
// 用法：
//   node fix3-regression.test.mjs                                    # 对修复后产物
//   GC_HTML=<备份路径>/console.html node fix3-regression.test.mjs     # 对修复前备份，应全部变红
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(process.env.GC_HTML || path.resolve(here, "../console.js"), "utf8");

function extractObj(marker) {
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("未找到 " + marker);
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error("花括号不配对 " + marker);
}
function extractFn(marker) {
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("未找到 " + marker);
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error("花括号不配对 " + marker);
}

const PLATFORMS = eval("(function(){" + extractObj("const PLATFORMS = {") + "; return PLATFORMS; })()");
const GITLAB = eval("(function(){" + extractObj("const GITLAB = {") + "; return GITLAB; })()");
const srcApi = extractFn("async function api(");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name, "->", detail); }
};

/* ============ FIX3-1：GitLab 删除文件不带 last_commit_id ============ */
{
  const del = GITLAB.translate("DELETE", "/repos/o/r/contents/src/a.js",
    { message: "del", sha: "BLOB_SHA", branch: "main" }, "o/r");
  check("FIX3-1a GitLab 删除文件不再携带 last_commit_id", !("last_commit_id" in del.body), JSON.stringify(del.body));
  check("FIX3-1b 删除仍保留 branch + commit_message",
    del.body.branch === "main" && del.body.commit_message === "del", JSON.stringify(del.body));
  check("FIX3-1c 删除 URL 仍正确", del.url === "/projects/o%2Fr/repository/files/src/a.js", del.url);
  // 对照：更新文件（有 sha 走 PUT）仍带 last_commit_id，证明只修了 DELETE 分支、未误伤 PUT
  const upd = GITLAB.translate("PUT", "/repos/o/r/contents/a.js",
    { message: "m", content: "QQ==", sha: "deadbeef", branch: "main" }, "o/r");
  check("FIX3-1d 更新文件（PUT+sha）仍带 last_commit_id", upd.method === "PUT" && upd.body.last_commit_id === "deadbeef", JSON.stringify(upd.body));
}

/* ============ FIX3-2：Gitee/GitCode 建/删分支改写 ============ */
{
  // 驱动真实 api()（注入 stub 依赖）捕获最终发出的 url 与请求体
  async function driveApi(platform, method, path, body) {
    let captured = null;
    const state = { reqGen: 1 };
    const apiCache = new Map();
    const fetchStub = async (url, opt) => {
      captured = { url, opt };
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) };
    };
    const activeAccount = () => ({ platform, token: "TOKEN12345678" });
    const updateRate = () => {};
    const logout = () => {};
    const $ = () => null;
    const fn = new Function("state", "apiCache", "PLATFORMS", "GITLAB", "activeAccount", "updateRate", "logout", "$", "fetch",
      srcApi + "\nreturn api;");
    const api = fn(state, apiCache, PLATFORMS, GITLAB, activeAccount, updateRate, logout, $, fetchStub);
    await api(method, path, body, { fullName: "o/r" });
    return captured;
  }

  const giteeNew = await driveApi("gitee", "POST", "/repos/o/r/git/refs", { ref: "refs/heads/dev", sha: "abc123" });
  check("FIX3-2a Gitee 建分支 URL 改写为 /branches（不含 access_token query）",
    giteeNew.url === "https://gitee.com/api/v5/repos/o/r/branches", giteeNew && giteeNew.url);
  check("FIX3-2b Gitee 建分支 body 映射为 {branch_name, refs}",
    giteeNew.opt.body === JSON.stringify({ branch_name: "dev", refs: "abc123" }), giteeNew && giteeNew.opt.body);
  check("FIX3-2g Gitee 认证走 Authorization 头而非 URL query",
    giteeNew.opt.headers && giteeNew.opt.headers.Authorization === "token TOKEN12345678",
    JSON.stringify(giteeNew && giteeNew.opt && giteeNew.opt.headers));

  const gitcodeNew = await driveApi("gitcode", "POST", "/repos/o/r/git/refs", { ref: "refs/heads/feat-x", sha: "abc123" });
  check("FIX3-2c GitCode 建分支同样改写 /branches",
    gitcodeNew.url === "https://api.gitcode.com/api/v5/repos/o/r/branches", gitcodeNew && gitcodeNew.url);

  const giteeDel = await driveApi("gitee", "DELETE", "/repos/o/r/git/refs/heads/feat%2Fx", undefined);
  check("FIX3-2d Gitee 删分支 URL 改写为 /branches/{branch}（不含 access_token query）",
    giteeDel.url === "https://gitee.com/api/v5/repos/o/r/branches/feat%2Fx", giteeDel && giteeDel.url);

  // 对照：GitHub 建分支仍走 /git/refs（未被误伤）
  const ghNew = await driveApi("github", "POST", "/repos/o/r/git/refs", { ref: "refs/heads/dev", sha: "abc123" });
  check("FIX3-2e GitHub 建分支仍直发 /git/refs（不改写）",
    ghNew.url === "https://api.github.com/repos/o/r/git/refs", ghNew && ghNew.url);
}

/* ============ FIX3-3：解绑当前活跃账号走 enterShell ============ */
{
  const iDelHandler = html.indexOf("$$('#view-settings [data-del]')");
  const iDelEnd = html.indexOf("\n  }));", iDelHandler);
  const srcSetDel = html.slice(iDelHandler, iDelEnd);
  check("FIX3-3a 解绑 onConfirm 记录 wasActive", /wasActive = i === state\.activeIdx/.test(srcSetDel), srcSetDel.slice(0, 120));
  check("FIX3-3b 解绑当前活跃账号调用 enterShell（全量重置）", /if \(wasActive\) \{ enterShell\(\);/.test(srcSetDel), "");
  check("FIX3-3c 解绑非活跃账号仍走轻量路径（state.user=null）", /state\.user = null;/.test(srcSetDel), "");
}

console.log("\n---- 结果: " + pass + " PASS / " + fail + " FAIL ----");
process.exit(fail ? 1 : 0);
