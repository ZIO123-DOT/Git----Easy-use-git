// 竞态修复回归测试（QA Edward / Yan —— starToggle 写操作竞态 + patchRepo 旧响应覆盖）
// 零依赖（仅 node:fs/node:path），从产物 console.html 用「花括号配对」提取真实函数源码，
// 注入 stub 依赖真实执行，验证两个修复确实生效。
//
// 覆盖：
//   [STAR-1] starToggle 在途切仓库不污染新仓库（取消收藏 + 收藏两条分支）
//   [STAR-2] starToggle 正常路径（对照组）仍正确更新
//   [STAR-3] isStarred 判定逻辑（真实提取源码驱动）
//   [PATCH-1] patchRepo 在途 reqGen 递增/切仓库时丢弃旧响应
//   [PATCH-2] patchRepo 正常路径（对照组）仍正确更新
//   [MUT-*]   变异验证：抹掉修复语句后断言应能抓到（证明断言对修复敏感，非碰巧全绿）
//
// 用法：
//   node electron-app/tests/starfix-regression.test.mjs                        # 对修复后产物（应全绿）
//   GC_HTML=<备份路径>/console.html node electron-app/tests/starfix-regression.test.mjs   # 对修复前备份（修复相关断言应变红）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(process.env.GC_HTML || path.resolve(here, "../console.html"), "utf8");

// ---- 提取工具：花括号配对截取函数源码（与 review-audit.test.mjs 同法） ----
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

const srcStarToggle = extractFn("async function starToggle(");
const srcPatchRepo = extractFn("async function patchRepo(");
const srcIsStarred = extractFn("function isStarred(");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name, "->", detail); }
};

// ============ 驱动：starToggle ============
// 注入真实提取的 isStarred（与 starToggle 同源），在 api 的 await 挂起期间可切换 state.repo。
async function driveStarToggle(src, { repoA, repoB, starredSet, switchDuringAwait }) {
  const state = { repo: repoA, starredSet: new Set(starredSet) };
  const isStarred = new Function("state", srcIsStarred + "\nreturn isStarred;")(state);
  let renderCount = 0;
  const toasts = [];
  const api = async () => { if (switchDuringAwait) state.repo = repoB; return {}; };
  const fn = new Function("state", "api", "toast", "renderRepoDetail", "isStarred",
    src + "\nreturn starToggle;");
  await fn(state, api, (m) => toasts.push(m), () => { renderCount++; }, isStarred)();
  return { repoA, repoB, state, renderCount, toasts };
}

// ============ 驱动：patchRepo ============
async function drivePatchRepo(src, { switchDuringAwait }) {
  const repoA = { full_name: "a/a", name: "a", description: "old" };
  const repoB = { full_name: "b/b", name: "b", description: "b-desc" };
  const updated = { full_name: "a/a", name: "a", description: "new" };
  const state = { reqGen: 5, repo: repoA, tab: "files", reposLoaded: true };
  let toastCount = 0, lastToast = null, renderCount = 0, loadReposCount = 0;
  const noop = () => {};
  const api = async () => {
    // 模拟 openRepo → loadContents 触发的代际递增 + 切仓库（在 PATCH 在途时发生）
    if (switchDuringAwait) { state.reqGen = 99; state.repo = repoB; }
    return updated;
  };
  const fn = new Function("state", "api", "toast", "loadRepos", "renderRepoDetail",
    "loadContents", "loadCommits", "loadBranches", "loadIssues", "loadPulls", "loadReleases", "loadRuns", "renderRepoSettings",
    src + "\nreturn patchRepo;");
  await fn(state, api, (m) => { toastCount++; lastToast = m; }, () => { loadReposCount++; },
    () => { renderCount++; }, noop, noop, noop, noop, noop, noop, noop, noop)({ name: "a" }, "名称已更新");
  return { repoA, repoB, updated, state, toastCount, lastToast, renderCount, loadReposCount };
}

// ============ 变异工具：把修复语句抹回旧写法（仅用于证明断言敏感性，不落盘） ============
function revertStarToggle(src) {
  let s = src;
  // 1) 抹掉开头捕获 + null 守卫（还原为 await 后实时读 state.repo）
  s = s.replace(/const repo = state\.repo;[\s\S]*?if \(!repo \|\| !full\) return;\n  try \{/, "try {");
  // 2) starred 判定还原为 isStarred()（实时读 state.repo）
  s = s.replace("const starred = state.starredSet.has(full) || repo.viewer_has_starred;", "const starred = isStarred();");
  // 3) 请求 URL 与写操作还原为实时 state.repo / state.repo.full_name
  s = s.replaceAll("'/user/starred/' + full, undefined, { fullName: full }",
    "'/user/starred/' + state.repo.full_name, undefined, { fullName: state.repo.full_name }");
  s = s.replaceAll("state.starredSet.delete(full);", "state.starredSet.delete(state.repo.full_name);");
  s = s.replaceAll("state.starredSet.add(full);", "state.starredSet.add(state.repo.full_name);");
  // 裸 repo.（repo.viewer_has_starred / repo.stargazers_count）→ state.repo.；负向断言避免误伤已存在的 state.repo.
  s = s.replace(/(?<!state\.)repo\./g, "state.repo.");
  // 4) 末尾无条件 renderRepoDetail()
  s = s.replace("if (state.repo === repo) renderRepoDetail();", "renderRepoDetail();");
  return s;
}

/* ================= STAR-1：starToggle 在途切仓库不污染新仓库 ================= */
// 场景 A1（取消收藏分支）：A、B 均已收藏；await 期间 state.repo 从 A 换到 B。
{
  const repoA = { full_name: "a/a", name: "a", viewer_has_starred: true, stargazers_count: 42 };
  const repoB = { full_name: "b/b", name: "b", viewer_has_starred: true, stargazers_count: 100 };
  const r = await driveStarToggle(srcStarToggle, { repoA, repoB, starredSet: ["a/a", "b/b"], switchDuringAwait: true });

  check("STAR-1a 取消收藏：在途切仓库后 B.viewer_has_starred 不被污染（仍 true）",
    r.repoB.viewer_has_starred === true, "B.viewer_has_starred=" + r.repoB.viewer_has_starred);
  check("STAR-1b 取消收藏：B.stargazers_count 不被错误递减（仍 100）",
    r.repoB.stargazers_count === 100, "B.stargazers_count=" + r.repoB.stargazers_count);
  check("STAR-1c 取消收藏：starredSet 不含对 B 的错误删除（b/b 仍在）",
    r.state.starredSet.has("b/b") === true, JSON.stringify([...r.state.starredSet]));
  check("STAR-1d 取消收藏：A 被正确更新（viewer_has_starred=false）",
    r.repoA.viewer_has_starred === false, "A.viewer_has_starred=" + r.repoA.viewer_has_starred);
  check("STAR-1e 取消收藏：A 被正确更新（stargazers_count-1=41）",
    r.repoA.stargazers_count === 41, "A.stargazers_count=" + r.repoA.stargazers_count);
  check("STAR-1f 取消收藏：starredSet 正确移除 A（a/a 不在）",
    r.state.starredSet.has("a/a") === false, JSON.stringify([...r.state.starredSet]));
  check("STAR-1g 取消收藏：在途切仓库后不刷新详情（renderRepoDetail 未被调用）",
    r.renderCount === 0, "renderCount=" + r.renderCount);
}

// 场景 A2（收藏分支）：A、B 均未收藏；await 期间 state.repo 从 A 换到 B。
{
  const repoA = { full_name: "a/a", name: "a", viewer_has_starred: false, stargazers_count: 5 };
  const repoB = { full_name: "b/b", name: "b", viewer_has_starred: false, stargazers_count: 200 };
  const r = await driveStarToggle(srcStarToggle, { repoA, repoB, starredSet: [], switchDuringAwait: true });

  check("STAR-1h 收藏：在途切仓库后 B.viewer_has_starred 不被污染（仍 false）",
    r.repoB.viewer_has_starred === false, "B.viewer_has_starred=" + r.repoB.viewer_has_starred);
  check("STAR-1i 收藏：B.stargazers_count 不被错误递增（仍 200）",
    r.repoB.stargazers_count === 200, "B.stargazers_count=" + r.repoB.stargazers_count);
  check("STAR-1j 收藏：starredSet 不含对 B 的错误添加（b/b 不在）",
    r.state.starredSet.has("b/b") === false, JSON.stringify([...r.state.starredSet]));
  check("STAR-1k 收藏：A 被正确更新（viewer_has_starred=true）",
    r.repoA.viewer_has_starred === true, "A.viewer_has_starred=" + r.repoA.viewer_has_starred);
  check("STAR-1l 收藏：A 被正确更新（stargazers_count+1=6）",
    r.repoA.stargazers_count === 6, "A.stargazers_count=" + r.repoA.stargazers_count);
  check("STAR-1m 收藏：starredSet 正确加入 A（a/a 在）",
    r.state.starredSet.has("a/a") === true, JSON.stringify([...r.state.starredSet]));
  check("STAR-1n 收藏：在途切仓库后不刷新详情（renderRepoDetail 未被调用）",
    r.renderCount === 0, "renderCount=" + r.renderCount);
}

/* ================= STAR-2：starToggle 正常路径（对照组，未切仓库） ================= */
// 场景 B1（取消收藏，未切仓库）
{
  const repoA = { full_name: "a/a", name: "a", viewer_has_starred: true, stargazers_count: 42 };
  const repoB = { full_name: "b/b", name: "b", viewer_has_starred: true, stargazers_count: 100 };
  const r = await driveStarToggle(srcStarToggle, { repoA, repoB, starredSet: ["a/a", "b/b"], switchDuringAwait: false });

  check("STAR-2a 取消收藏对照组：A.viewer_has_starred=false",
    r.repoA.viewer_has_starred === false, "A.viewer_has_starred=" + r.repoA.viewer_has_starred);
  check("STAR-2b 取消收藏对照组：A.stargazers_count=41",
    r.repoA.stargazers_count === 41, "A.stargazers_count=" + r.repoA.stargazers_count);
  check("STAR-2c 取消收藏对照组：starredSet 移除 a/a",
    r.state.starredSet.has("a/a") === false, JSON.stringify([...r.state.starredSet]));
  check("STAR-2d 取消收藏对照组：刷新详情（renderRepoDetail 被调用）",
    r.renderCount === 1, "renderCount=" + r.renderCount);
  check("STAR-2e 取消收藏对照组：toast 提示已取消收藏",
    r.toasts[0] === "已取消收藏", JSON.stringify(r.toasts));
}
// 场景 B2（收藏，未切仓库）
{
  const repoA = { full_name: "a/a", name: "a", viewer_has_starred: false, stargazers_count: 5 };
  const repoB = { full_name: "b/b", name: "b", viewer_has_starred: false, stargazers_count: 200 };
  const r = await driveStarToggle(srcStarToggle, { repoA, repoB, starredSet: [], switchDuringAwait: false });

  check("STAR-2f 收藏对照组：A.viewer_has_starred=true",
    r.repoA.viewer_has_starred === true, "A.viewer_has_starred=" + r.repoA.viewer_has_starred);
  check("STAR-2g 收藏对照组：A.stargazers_count=6",
    r.repoA.stargazers_count === 6, "A.stargazers_count=" + r.repoA.stargazers_count);
  check("STAR-2h 收藏对照组：starredSet 加入 a/a",
    r.state.starredSet.has("a/a") === true, JSON.stringify([...r.state.starredSet]));
  check("STAR-2i 收藏对照组：刷新详情（renderRepoDetail 被调用）",
    r.renderCount === 1, "renderCount=" + r.renderCount);
  check("STAR-2j 收藏对照组：toast 提示已收藏",
    r.toasts[0] === "已收藏", JSON.stringify(r.toasts));
}

/* ================= STAR-3：isStarred 判定逻辑（真实提取源码驱动） ================= */
{
  const run = (repo, set) => {
    const state = { repo, starredSet: new Set(set) };
    const isStarred = new Function("state", srcIsStarred + "\nreturn isStarred;")(state);
    return isStarred();
  };
  // 真实 isStarred 返回的是 state.repo && (...)（null/undefined/true），非严格布尔；调用方按真值使用，故此处断言 falsy
  check("STAR-3a isStarred：state.repo 为 null 返回 falsy", !run(null, []), String(run(null, [])));
  check("STAR-3b isStarred：starredSet 命中返回 true", run({ full_name: "x/y" }, ["x/y"]) === true, "");
  check("STAR-3c isStarred：viewer_has_starred 命中返回 true", run({ full_name: "x/y", viewer_has_starred: true }, []) === true, "");
  check("STAR-3d isStarred：两者皆无返回 falsy", !run({ full_name: "x/y" }, []), String(run({ full_name: "x/y" }, [])));
}

/* ================= PATCH-1：patchRepo 在途 reqGen 递增/切仓库时丢弃旧响应 ================= */
{
  const r = await drivePatchRepo(srcPatchRepo, { switchDuringAwait: true });
  check("PATCH-1a 旧响应不覆盖当前仓库（state.repo 仍是 B）",
    r.state.repo === r.repoB, "state.repo.full_name=" + (r.state.repo && r.state.repo.full_name));
  check("PATCH-1b 守卫拦截后不误报成功（toast 未被调用）",
    r.toastCount === 0, "toastCount=" + r.toastCount);
  check("PATCH-1c 守卫拦截后不刷新详情（renderRepoDetail 未被调用）",
    r.renderCount === 0, "renderCount=" + r.renderCount);
  check("PATCH-1d 守卫拦截后不重载列表（loadRepos 未被调用）",
    r.loadReposCount === 0, "loadReposCount=" + r.loadReposCount);
}

/* ================= PATCH-2：patchRepo 正常路径（对照组，未切仓库） ================= */
{
  const r = await drivePatchRepo(srcPatchRepo, { switchDuringAwait: false });
  check("PATCH-2a 正常路径：state.repo 被更新为 updated",
    r.state.repo === r.updated, "state.repo.full_name=" + (r.state.repo && r.state.repo.full_name));
  check("PATCH-2b 正常路径：字段生效（description=new）",
    r.state.repo.description === "new", "description=" + r.state.repo.description);
  check("PATCH-2c 正常路径：toast 被调用且带 okMsg",
    r.toastCount === 1 && r.lastToast === "名称已更新", "toastCount=" + r.toastCount + " lastToast=" + r.lastToast);
  check("PATCH-2d 正常路径：renderRepoDetail 被调用",
    r.renderCount === 1, "renderCount=" + r.renderCount);
  check("PATCH-2e 正常路径：loadRepos 被调用",
    r.loadReposCount === 1, "loadReposCount=" + r.loadReposCount);
  check("PATCH-2f 正常路径：reposLoaded 置 false",
    r.state.reposLoaded === false, "reposLoaded=" + r.state.reposLoaded);
}

/* ================= MUT：变异验证（抹掉修复语句后断言应能抓到） ================= */
// MUT-1：抹掉 starToggle 末尾的 renderRepoDetail 守卫 → 在途切仓库仍会刷新详情
{
  const mutant = srcStarToggle.replace("if (state.repo === repo) renderRepoDetail();", "renderRepoDetail();");
  const repoA = { full_name: "a/a", name: "a", viewer_has_starred: true, stargazers_count: 42 };
  const repoB = { full_name: "b/b", name: "b", viewer_has_starred: true, stargazers_count: 100 };
  const r = await driveStarToggle(mutant, { repoA, repoB, starredSet: ["a/a", "b/b"], switchDuringAwait: true });
  check("MUT-1 敏感性：抹掉 renderRepoDetail 守卫后，在途切仓库会误刷新详情",
    mutant !== srcStarToggle && r.renderCount === 1, "mutantChanged=" + (mutant !== srcStarToggle) + " renderCount=" + r.renderCount);
}
// MUT-2：抹掉 starToggle 的仓库捕获（还原为实时读 state.repo）→ 污染 B
{
  const mutant = revertStarToggle(srcStarToggle);
  const repoA = { full_name: "a/a", name: "a", viewer_has_starred: true, stargazers_count: 42 };
  const repoB = { full_name: "b/b", name: "b", viewer_has_starred: true, stargazers_count: 100 };
  const r = await driveStarToggle(mutant, { repoA, repoB, starredSet: ["a/a", "b/b"], switchDuringAwait: true });
  check("MUT-2a 敏感性：抹掉仓库捕获后，B.viewer_has_starred 被错误置 false",
    mutant !== srcStarToggle && r.repoB.viewer_has_starred === false, "mutantChanged=" + (mutant !== srcStarToggle) + " B.viewer_has_starred=" + r.repoB.viewer_has_starred);
  check("MUT-2b 敏感性：抹掉仓库捕获后，B.stargazers_count 被错误递减为 99",
    mutant !== srcStarToggle && r.repoB.stargazers_count === 99, "mutantChanged=" + (mutant !== srcStarToggle) + " B.stargazers_count=" + r.repoB.stargazers_count);
}
// MUT-3：抹掉 patchRepo 的 reqGen 守卫 → 旧响应覆盖当前仓库并误报成功
{
  const mutant = srcPatchRepo.replace("if (gen !== state.reqGen) return;", "");
  const r = await drivePatchRepo(mutant, { switchDuringAwait: true });
  check("MUT-3 敏感性：抹掉 reqGen 守卫后，旧响应覆盖当前仓库并误报成功",
    mutant !== srcPatchRepo && r.state.repo === r.updated && r.toastCount === 1,
    "mutantChanged=" + (mutant !== srcPatchRepo) + " state.repo=" + (r.state.repo && r.state.repo.full_name) + " toastCount=" + r.toastCount);
}

console.log("\n---- 结果: " + pass + " PASS / " + fail + " FAIL ----");
process.exit(fail ? 1 : 0);
