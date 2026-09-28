// GitLab 适配器单测（零依赖：直接从 parts/part_adapters.js.html 提取 GITLAB 对象并验证）
// 运行：node electron-app/tests/gitlab-adapter.test.mjs
// 覆盖：translate 全部路由分支 + normalize 全部 case + 回归保护
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../parts/part_adapters.js.html");
const html = fs.readFileSync(src, "utf8");
const start = html.indexOf("const GITLAB = {");
if (start < 0) throw new Error("未找到 GITLAB 定义");
let depth = 0, end = -1;
for (let i = start; i < html.length; i++) {
  if (html[i] === "{") depth++;
  else if (html[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
const GITLAB = eval("(function(){" + html.slice(start, end) + "; return GITLAB; })()");
const T = (m, p, b) => GITLAB.translate(m, p, b);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name, "->", detail); }
};

/* ============ 一、路径翻译：顶层用户/列表类 ============ */
let r = T("GET", "/user");
check("用户信息 → /user", r.url === "/user" && r.norm === "user", JSON.stringify(r));

r = T("POST", "/user/repos", { name: "d", description: "x", private: true, auto_init: true });
check("建仓库 → POST /projects", r.url === "/projects" && r.method === "POST", JSON.stringify(r));
check("建仓库 visibility/readme 映射", r.body.visibility === "private" && r.body.initialize_with_readme === true, JSON.stringify(r.body));
r = T("POST", "/user/repos", { name: "pub", private: false, auto_init: false });
check("建公开仓库映射", r.body.visibility === "public" && r.body.initialize_with_readme === false, JSON.stringify(r.body));

r = T("GET", "/user/repos?page=1&per_page=100&type=owner&sort=pushed");
check("仓库列表 → membership", r.url.startsWith("/projects?membership=true") && r.norm === "repos", JSON.stringify(r));
r = T("GET", "/user/repos?page=3&per_page=50");
check("仓库列表翻页参数透传", r.url.includes("page=3") && r.url.includes("per_page=50"), JSON.stringify(r));

r = T("PUT", "/user/starred/o/r"); check("收藏 → /star", r.url === "/projects/o%2Fr/star", JSON.stringify(r));
r = T("DELETE", "/user/starred/o/r"); check("取消收藏 → /unstar", r.url === "/projects/o%2Fr/unstar", JSON.stringify(r));
r = T("GET", "/user/starred?per_page=100&page=3");
check("收藏列表翻页带 page", r.url.includes("page=3") && r.norm === "repos", JSON.stringify(r));

r = T("GET", "/notifications?per_page=50");
check("通知 → unsupported", r.norm === "unsupported", JSON.stringify(r));
r = T("GET", "/gists?per_page=50");
check("Gist → unsupported", r.norm === "unsupported", JSON.stringify(r));

r = T("GET", "/search/repositories?q=vue&per_page=24");
check("搜索", r.url.startsWith("/projects?search=vue") && r.url.includes("order_by=star_count") && r.norm === "searchrepos", JSON.stringify(r));

/* ============ 二、路径翻译：仓库详情与子资源 ============ */
r = T("GET", "/repos/o/r");
check("仓库详情", r.url === "/projects/o%2Fr" && r.norm === "repo", JSON.stringify(r));
r = T("DELETE", "/repos/o/r");
check("删仓库", r.url === "/projects/o%2Fr" && r.method === "DELETE", JSON.stringify(r));
r = T("PATCH", "/repos/o/r", { name: "nn", description: "dd", private: true, default_branch: "main", archived: true });
check("改仓库 → PUT /projects", r.url === "/projects/o%2Fr" && r.method === "PATCH", JSON.stringify(r));
check("改仓库字段映射(visibility/archived)", r.body.visibility === "private" && r.body.archived === true && r.body.name === "nn", JSON.stringify(r.body));
r = T("POST", "/repos/o/r/forks");
check("Fork → /fork", r.url === "/projects/o%2Fr/fork", JSON.stringify(r));

r = T("GET", "/repos/o/r/contents?ref=main");
check("目录列表 → repository/tree", r.url.includes("/repository/tree") && r.norm === "tree", JSON.stringify(r));
r = T("GET", "/repos/o/r/contents/src/a.js?ref=main");
check("读文件", r.url.startsWith("/projects/o%2Fr/repository/files/") && r.norm === "file", JSON.stringify(r));
r = T("PUT", "/repos/o/r/contents/src/a.js", { message: "m", content: "QQ==", branch: "main", encoding: "base64" });
check("写文件编码透传", r.body.encoding === "base64" && r.body.commit_message === "m", JSON.stringify(r.body));
r = T("DELETE", "/repos/o/r/contents/src/a.js", { message: "del", sha: "sh", branch: "main" });
check("删文件", r.url.includes("/repository/files/") && r.method === "DELETE" && r.body.commit_message === "del", JSON.stringify(r));

r = T("GET", "/repos/o/r/branches?per_page=100");
check("分支列表", r.url.includes("/repository/branches") && r.norm === "branches", JSON.stringify(r));
r = T("POST", "/repos/o/r/git/refs", { ref: "refs/heads/dev", sha: "abc" });
check("建分支", r.url === "/projects/o%2Fr/repository/branches" && r.body.branch === "dev" && r.body.ref === "abc", JSON.stringify(r));
r = T("DELETE", "/repos/o/r/git/refs/heads/dev");
check("删分支", r.url === "/projects/o%2Fr/repository/branches/dev", JSON.stringify(r));

r = T("GET", "/repos/o/r/commits?sha=dev&per_page=30");
check("提交列表 + ref 映射", r.url.includes("/repository/commits") && r.url.includes("ref_name=dev") && r.norm === "commits", JSON.stringify(r));

r = T("GET", "/repos/o/r/issues?state=open&per_page=100&sort=created&direction=desc");
check("issues state=open → opened", r.url.includes("state=opened") && r.norm === "issues", JSON.stringify(r));
r = T("GET", "/repos/o/r/issues?state=closed");
check("issues state=closed → closed", r.url.includes("state=closed"), JSON.stringify(r));
r = T("GET", "/repos/o/r/issues?state=all");
check("issues state=all → all", r.url.includes("state=all"), JSON.stringify(r));
r = T("POST", "/repos/o/r/issues", { title: "t", body: "b" });
check("建 issue（description 映射）", r.url === "/projects/o%2Fr/issues" && r.body.description === "b", JSON.stringify(r));
r = T("PATCH", "/repos/o/r/issues/7", { state: "closed" });
check("关 issue（state_event）", r.url === "/projects/o%2Fr/issues/7" && r.body.state_event === "close", JSON.stringify(r));
r = T("PATCH", "/repos/o/r/issues/7", { state: "open" });
check("重开 issue（state_event）", r.body.state_event === "reopen", JSON.stringify(r));
r = T("POST", "/repos/o/r/issues/7/comments", { body: "hi" });
check("issue 评论 → notes", r.url === "/projects/o%2Fr/issues/7/notes" && r.body.body === "hi", JSON.stringify(r));

r = T("GET", "/repos/o/r/pulls");
check("MR 列表", r.norm === "pulls", JSON.stringify(r));
r = T("GET", "/repos/o/r/pulls/9/files?per_page=100");
check("PR 变更文件 → changes", r.url === "/projects/o%2Fr/merge_requests/9/changes" && r.norm === "prfiles", JSON.stringify(r));

r = T("GET", "/repos/o/r/releases");
check("Releases 列表", r.url.includes("/releases") && r.norm === "releases", JSON.stringify(r));
r = T("DELETE", "/repos/o/r/releases/v1.0.0");
check("删 Release", r.url === "/projects/o%2Fr/releases/v1.0.0" && r.method === "DELETE", JSON.stringify(r));

r = T("GET", "/repos/o/r/actions/runs?per_page=20");
check("Actions → pipelines", r.url.includes("/pipelines") && r.norm === "pipelines", JSON.stringify(r));

r = T("PUT", "/repos/o/r/star");
check("仓库级 star → /star", r.url === "/projects/o%2Fr/star", JSON.stringify(r));
r = T("DELETE", "/repos/o/r/star");
check("仓库级 unstar → /unstar", r.url === "/projects/o%2Fr/unstar", JSON.stringify(r));

r = T("GET", "/repos/o/r/labels");
check("未知子路径兜底（拼接到项目路径）", r.url === "/projects/o%2Fr/labels", JSON.stringify(r));

/* ============ 三、响应归一化：全部 case ============ */
const proj = { id: 1, path: "a", path_with_namespace: "o/a", visibility: "public", star_count: 1, web_url: "x", default_branch: "main", last_activity_at: "2026" };
check("repos 归一化（数组）", Array.isArray(GITLAB.normalize([proj], "repos")) && GITLAB.normalize([proj], "repos")[0].full_name === "o/a", "");
check("searchrepos → {items}", Array.isArray(GITLAB.normalize([proj], "searchrepos").items), "");
check("repo 归一化 private 反转", GITLAB.normalize(proj, "repo").private === false && GITLAB.normalize({ ...proj, visibility: "private" }, "repo").private === true, "");
check("user 归一化", GITLAB.normalize({ username: "u", name: "N", avatar_url: "a", web_url: "w" }, "user").login === "u", "");
check("tree 归一化（dir/blob）",
  GITLAB.normalize([{ name: "d", path: "d", type: "tree" }, { name: "f", path: "d/f", type: "blob" }], "tree")[0].type === "dir" &&
  GITLAB.normalize([{ name: "d", path: "d", type: "tree" }, { name: "f", path: "d/f", type: "blob" }], "tree")[1].type === "file", "");
check("file 归一化（base64 content）", GITLAB.normalize({ file_name: "a.js", file_path: "src/a.js", size: 3, content: "QQ==", last_commit_id: "s" }, "file").encoding === "base64", "");
check("branches 归一化（commit.sha）", GITLAB.normalize([{ name: "main", commit: { id: "abc" } }], "branches")[0].commit.sha === "abc", "");
check("commits 归一化", GITLAB.normalize([{ id: "s", message: "m", author_name: "n", committed_date: "2026", web_url: "w" }], "commits")[0].sha === "s", "");
check("issues 归一化（iid/state/labels）",
  GITLAB.normalize([{ iid: 3, title: "t", state: "opened", author: { username: "u" }, labels: ["bug"], web_url: "w" }], "issues")[0].number === 3 &&
  GITLAB.normalize([{ iid: 3, state: "opened" }], "issues")[0].state === "open", "");
check("issues 过滤 merge_request 条目", GITLAB.normalize([{ iid: 1, merge_request: true }, { iid: 2, state: "opened" }], "issues").length === 1, "");
check("pulls 归一化 merged_at", GITLAB.normalize([{ iid: 1, title: "t", state: "merged", merged_at: "2026", author: { username: "u" }, source_branch: "a", target_branch: "b", web_url: "x" }], "pulls")[0].merged === true, "");
check("pulls 状态 opened → open", GITLAB.normalize([{ iid: 2, state: "opened" }], "pulls")[0].state === "open", "");
check("releases 归一化", GITLAB.normalize([{ tag_name: "v1", name: "v1", released_at: "2026", _links: { self: "u" } }], "releases")[0].tag_name === "v1", "");
check("pipelines → workflow_runs", Array.isArray(GITLAB.normalize([{ id: 5, ref: "main", status: "success", web_url: "w", created_at: "2026" }], "pipelines").workflow_runs), "");
check("pipelines conclusion 映射", GITLAB.normalize([{ id: 5, status: "failed" }], "pipelines").workflow_runs[0].conclusion === "failure", "");
check("prfiles 归一化（diff 映射）", GITLAB.normalize({ changes: [{ new_path: "a.js", diff: "@@" }] }, "prfiles")[0].patch === "@@", "");
check("失败态归一化回传原值", GITLAB.normalize(undefined, "repo") === undefined, "");
check("未知 norm 透传", GITLAB.normalize({ raw: 1 }, "unknown-norm").raw === 1, "");

// —— P1-3/P1-4 修复锁定：单次编码 + 嵌套组切分 ——
r = T("GET", "/repos/o/r/contents/src/a%20b.js?ref=feat%2Fx");
check("P1-3 空格路径单次编码（ref 经 URLSearchParams 规范化后 / 合法）", r.url.includes("/files/src/a%20b.js") && !r.url.includes("%25") && r.url.includes("ref=feat/x"), JSON.stringify(r));
r = T("DELETE", "/repos/o/r/git/refs/heads/feat%20x");
check("P1-3 分支名单次编码", r.url.endsWith("/branches/feat%20x") && !r.url.includes("%25"), JSON.stringify(r));
r = T("GET", "/repos/group/sub/repo");
check("P1-4 嵌套组仓库整段 full_name", r.url === "/projects/group%2Fsub%2Frepo", JSON.stringify(r));
r = T("GET", "/repos/group/sub/repo/branches?per_page=100");
check("P1-4 嵌套组 + 子资源", r.url.startsWith("/projects/group%2Fsub%2Frepo/repository/branches") && r.norm === "branches", JSON.stringify(r));
r = T("DELETE", "/repos/a/b/c/d");
check("P1-4 三层嵌套组删除", r.url === "/projects/a%2Fb%2Fc%2Fd", JSON.stringify(r));

console.log("\n---- 结果: " + pass + " PASS / " + fail + " FAIL ----");
process.exit(fail ? 1 : 0);
