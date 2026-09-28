// 会话清理单测：验证 resetSession() 清空全部会话字段（防"逐字段手抄清理清单"再次遗漏）
// 运行：node electron-app/tests/session-reset.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../parts/part2.js.html");
const html = fs.readFileSync(src, "utf8");

// 1) 用真实 state 字面量构造 fixture（自动跟随源码字段变化，避免测试漂移）
const sIdx = html.indexOf("const state = {");
const sEnd = html.indexOf("\n};", sIdx);
if (sIdx < 0 || sEnd < 0) throw new Error("未找到 state 定义");
const stateLiteral = html.slice(sIdx, sEnd + 3);

// 2) 提取 resetSession 函数体
const fIdx = html.indexOf("function resetSession(){");
if (fIdx < 0) throw new Error("未找到 resetSession");
let depth = 0, fEnd = -1;
for (let i = fIdx; i < html.length; i++) {
  if (html[i] === "{") depth++;
  else if (html[i] === "}") { depth--; if (depth === 0) { fEnd = i + 1; break; } }
}
const fnLiteral = html.slice(fIdx, fEnd);

const apiCache = { cleared: false, clear() { this.cleared = true; } };
const state = eval("(function(){" + stateLiteral + "; return state; })()");
eval("(function(){ var apiCache = arguments[0]; " + fnLiteral + "; arguments[1](resetSession); })")(apiCache, (fn) => {
  // 3) 灌入"脏"会话数据
  state.user = { login: "A" };
  state.repos = [{ id: 1 }]; state.reposLoaded = true;
  state.selected.add(12345);
  state.filter = "private"; state.query = "abc";
  state.stars = [{ full_name: "other/proj" }]; state.starsLoaded = true;
  state.starredSet.add("other/proj");
  state.notifications = [{ id: 1 }]; state.notifLoaded = true; state.notifAll = true; state.notifCount = 7;
  state.gists = [{ id: 1 }]; state.gistsLoaded = true;
  state.searchResults = [{ id: 1 }]; state.searchQuery = "q"; state.searching = true;
  state.repo = { full_name: "o/r" }; state.branches = [{}]; state.branch = "dev";
  state.tab = "issues"; state.path = "src"; state.file = { name: "a" };
  state.commits = [{}]; state.issues = [{}]; state.issueFilter = "closed";
  state.pulls = [{}]; state.releases = [{}]; state.runs = [{}];
  const genBefore = state.reqGen;

  fn();

  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.error("FAIL", name); } };
  check("user 清空", state.user === null);
  check("repos 清空", state.repos.length === 0 && state.reposLoaded === false);
  check("selected 清空（原 P1）", state.selected.size === 0);
  check("filter/query 复位", state.filter === "all" && state.query === "");
  check("stars 清空", state.stars.length === 0 && state.starsLoaded === false);
  check("starredSet 清空（本轮 P2）", state.starredSet.size === 0);
  check("notifications 清空", state.notifications.length === 0 && state.notifLoaded === false && state.notifAll === false && state.notifCount === 0);
  check("gists 清空", state.gists.length === 0 && state.gistsLoaded === false);
  check("search 状态复位", state.searchResults === null && state.searchQuery === "" && state.searching === false);
  check("repo 详情复位", state.repo === null && state.branches.length === 0 && state.branch === null);
  check("repo 视图游标复位", state.tab === "files" && state.path === "" && state.file === null);
  check("子列表复位", state.commits.length === 0 && state.issues.length === 0 && state.issueFilter === "open");
  check("pulls/releases/runs 复位", state.pulls.length === 0 && state.releases.length === 0 && state.runs.length === 0);
  check("apiCache 已清（上上轮）", apiCache.cleared === true);
  check("reqGen 递增（作废在途请求）", state.reqGen === genBefore + 1);
  check("持久化字段不受影响（theme/accounts）", state.theme === "light" && Array.isArray(state.accounts));
  console.log("\n---- 结果: " + pass + " PASS / " + fail + " FAIL ----");
  process.exit(fail ? 1 : 0);
});
