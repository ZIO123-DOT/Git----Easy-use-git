
/* ============================================================
   多平台适配层：GitHub / GitLab / Gitee / GitCode
   - PLATFORMS: 平台定义（API 基址、认证头、能力、token 入口）
   - caps.treeVerify / caps.contentsVerify：上传后校验能力（拖拽上传用）。
       treeVerify=true 表示该平台支持 Git Trees API 一次拉全树
       GET /repos/{o}/{r}/git/trees/{ref}?recursive=1 → { tree:[{path,type,…}], truncated }。
       2026-09-17 实测：
         · GitHub  → 顶层含 truncated，recursive 正常返回 blob ✅
         · Gitee   → 顶层含 truncated，recursive 返回全量（数万条，含 blob 与 tree）✅
         · GitCode → ❌ 不可用：recursive 不生效且服务端按 20/100 分页；返回条目 type 全是 tree、零个 blob，
                     顶层无 truncated、亦无可靠「已到末页」语义 → 无法据其判断某文件是否存在。
         · GitLab  → ❌ 其 /projects/:id/repository/tree 是分页数组、无 truncated 标志，非一次性全量。
       故 treeVerify 仅 github/gitee 为 true；gitcode/gitlab 为 false，统一走 contentsVerify 逐文件校验（结果精确、无假阴性）。
       contentsVerify=true 表示可用 GET /repos/{full}/contents/{path}?ref={ref} 逐文件确认落地。
   - accounts: 多账号管理（localStorage 持久化，可绑定多平台多账号）
   - GitLab 适配器：把 GitHub 风格的 api() 调用翻译成 GitLab v4
   - Gitee / GitCode：API v5 兼容 GitHub 风格，直接透传 + 轻量归一化
   ============================================================ */
const PLATFORMS = {
  github: {
    label: 'GitHub',
    apiBase: 'https://api.github.com',
    auth: t => ({ 'Authorization': 'Bearer ' + t }),
    tokenUrl: 'https://github.com/settings/tokens/new?scopes=repo,delete_repo&description=Git控制台',
    tokenHint: 'ghp_ 开头的 Classic Token，勾选 repo + delete_repo',
    caps: { notifications: true, gists: true, actions: true, releases: true, editFile: true, search: true, treeVerify: true, contentsVerify: true },
  },
  gitlab: {
    label: 'GitLab',
    apiBase: 'https://gitlab.com/api/v4',
    auth: t => ({ 'PRIVATE-TOKEN': t }),
    tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Git%E6%8E%A7%E5%88%B6%E5%8F%B0&scopes=api,delete_repository',
    tokenHint: 'Personal Access Token，勾选 api + delete_repository',
    caps: { notifications: false, gists: false, actions: true, releases: true, editFile: true, search: true, treeVerify: false, contentsVerify: true },
  },
  gitee: {
    label: 'Gitee',
    apiBase: 'https://gitee.com/api/v5',
    // Gitee 官方 API v5 支持经请求头认证（Authorization: token <access_token>），
    // 与 GitHub/GitLab/GitCode 保持一致，避免 token 流经 URL query（代理与访问日志可记录）。
    auth: t => ({ 'Authorization': 'token ' + t }),
    tokenUrl: 'https://gitee.com/profile/personal_access_tokens',
    tokenHint: 'Gitee 私人令牌（勾选 projects, issues, pull_requests, user_info）',
    caps: { notifications: false, gists: false, actions: false, releases: true, editFile: true, search: true, treeVerify: true, contentsVerify: true },
  },
  gitcode: {
    label: 'GitCode',
    // 2026-09-15 实测：web-api.gitcode.com 是 CloudWAF 保护的前端域（对非浏览器客户端 418 拦截、带 Origin 直接断连），
    // 真正的开放 API 域是 api.gitcode.com（Bearer 直连 200，且完整支持 CORS：204 预检 + ACAO 回显任意 Origin）
    apiBase: 'https://api.gitcode.com/api/v5',
    auth: t => ({ 'Authorization': 'Bearer ' + t }),
    tokenUrl: 'https://gitcode.com/setting/token-classic/create',
    tokenHint: 'GitCode 个人访问令牌（头像 → 个人设置 → 访问令牌 新建；v5 与 GitHub 风格兼容）',
    // treeVerify=false：实测 GitCode 的 git/trees 只返回目录、零 blob 且分页无 truncated 标志，
    // 据其过滤 blob 会得到空集 → 把真实存在的文件误判为 missing（假阴性）。故降级走 contentsVerify 逐文件校验。
    caps: { notifications: false, gists: false, actions: false, releases: true, editFile: true, search: true, treeVerify: false, contentsVerify: true },
  },
};

/* ---------- 账号管理 ---------- */
async function loadAccounts() {
  const fromLocal = () => {
    try {
      let arr = JSON.parse(localStorage.getItem('gc_accounts') || '[]');
      if (!Array.isArray(arr)) arr = [];
      return arr;
    } catch (e) { return []; }
  };
  // 优先加密库（桌面版 safeStorage/DPAPI）；Edge app 模式回退 localStorage
  let readOnlyToastExtra = ''; // ENG-8：只读降级下 legacy Token 保留在本地时，向只读提示追加说明
  if (location.protocol !== 'file:') {
    try {
      const d = await fetch(bridgeURL('secrets-get')).then(r => r.json());
      if (d && d.error) {
        // 令牌库存在但读不出（加密不可用/库损坏/换机后 DPAPI 失效）：进入只读降级，禁止后续 saveAccounts 把空库写回——防止覆盖丢 Token
        state.vaultReadOnly = true;
        state.accounts = fromLocal();
        setTimeout(() => toast('令牌库无法读取（换机/换用户后加密数据无法解密，属已知限制），已进入只读模式；请退出后重新登录以保存新 Token' + readOnlyToastExtra, 'err'), 800);
      } else {
        state.vaultReadOnly = false;
        state.accounts = Array.isArray(d.accounts) ? d.accounts : fromLocal();
        // 加密库读取成功：清除 localStorage 里的明文 Token 副本（历史遗留的回退数据）
        localStorage.removeItem('gc_accounts');
      }
    } catch (e) { state.accounts = fromLocal(); }
  } else {
    state.accounts = fromLocal();
  }
  if (!Array.isArray(state.accounts)) state.accounts = [];
  // 白名单重建：只保留 platform/token/label 三个已知字段，__proto__/constructor 等杂键自然被丢弃
  const cleanAccounts = [];
  for (const a of state.accounts) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    if (typeof a.token !== 'string' || !a.token || !PLATFORMS[a.platform]) continue;
    cleanAccounts.push({
      platform: a.platform,
      token: a.token,
      label: typeof a.label === 'string' && a.label ? a.label : PLATFORMS[a.platform].label,
    });
  }
  state.accounts = cleanAccounts;
  // 旧版单 token 迁移（迁移后必须立刻持久化，否则重启丢账号）
  const legacy = localStorage.getItem('ghc_token');
  let migrated = false;
  if (legacy && !state.accounts.some(a => a.token === legacy)) {
    state.accounts.push({ platform: 'github', label: 'GitHub', token: legacy });
    migrated = true;
  }
  // ENG-8：删源必须以持久化成功为前提——vaultReadOnly 时 saveAccounts 会静默早退（不落盘），
  // 此时删掉 localStorage 源会让这条 Token 永久丢失。保留源，恢复正常后下次启动会再次迁移并入
  if (legacy && !state.vaultReadOnly) localStorage.removeItem('ghc_token');
  if (state.vaultReadOnly && migrated) readOnlyToastExtra = '；旧版迁移的 Token 仍保存在本地，恢复正常后自动并入';
  if (migrated) await saveAccounts();
  const idx = parseInt(localStorage.getItem('gc_active') || '0', 10);
  state.activeIdx = state.accounts[idx] ? idx : (state.accounts.length ? 0 : -1);
}
let filePlainWarned = false; // file: 明文模式仅提示一次，避免每次保存都弹
async function saveAccounts() {
  // 只读降级：令牌库不可读时禁止落盘——空库写回会覆盖全部 Token（数据丢失链的最后一道闸）
  if (state.vaultReadOnly) {
    console.warn('saveAccounts: vault read-only, skip persist');
    return;
  }
  localStorage.setItem('gc_active', String(Math.max(0, state.activeIdx)));
  if (location.protocol === 'file:') {
    // Edge / app 模式（file: 协议）没有 safeStorage 加密后端，只能落 localStorage 明文。
    // 此处为非加密存储，属该模式下的已知限制（Electron 桌面模式走下面的加密库分支）。
    localStorage.setItem('gc_accounts', JSON.stringify(state.accounts));
    if (!filePlainWarned) {
      filePlainWarned = true;
      toast('当前为浏览器/Edge 模式，Token 以未加密方式保存在本机；如需加密存储请使用桌面版', 'err');
    }
    return;
  }
  // 加密库保存（带一次重试）：失败绝不回退写 localStorage 明文（否则与「Windows 凭据加密存储」的宣传冲突）——
  // 只提示用户，宁可让其重启后重新登录，也不落明文。
  const persist = () => fetch(bridgeURL('secrets-set'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accounts: state.accounts }),
  }).then(r => r.json());
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await persist();
      if (!d || d.ok === false) throw new Error('persist rejected');
      return;
    } catch (e) { /* 失败重试一次 */ }
  }
  toast('Token 保存失败，请注意重启后可能需重新登录', 'err');
}
function activeAccount() {
  return state.accounts[state.activeIdx] || null;
}
function activePlatform() {
  const a = activeAccount();
  return a ? PLATFORMS[a.platform] : null;
}
function addAccount(platform, token, label) {
  const P = PLATFORMS[platform];
  const acct = { platform, token, label: label || P.label };
  const i = state.accounts.findIndex(a => a.platform === platform && a.token === token);
  if (i >= 0) { state.activeIdx = i; }
  else { state.accounts.push(acct); state.activeIdx = state.accounts.length - 1; }
  saveAccounts();
}
function removeAccount(i) {
  const wasActive = i === state.activeIdx;
  state.accounts.splice(i, 1);
  if (state.activeIdx > i) state.activeIdx -= 1;       // 删的是前面的账号：指针左移
  else if (wasActive) state.activeIdx = Math.min(i, state.accounts.length - 1); // 删的是当前：指向继任者
  if (state.activeIdx < 0 && state.accounts.length) state.activeIdx = 0;
  saveAccounts();
}

/* ---------- GitLab 适配器 ---------- */
const GITLAB = {
  enc: s => encodeURIComponent(s),
  translate(method, path, body, fullName) {
    // 把 GitHub 风格 path 翻译为 GitLab v4 调用；full = owner/repo（GitLab 支持多层嵌套组 group/sub/repo）。
    // 路由分发：顶层（用户态/列表/搜索/通知）→ /repos/{full_name}/... 子路由（见 _translateRepo）。
    // 匹配优先级：精确匹配 > startsWith 匹配 > 兜底；/user/starred/{full} PUT/DELETE 必须在 /user/starred 列表分支之前，否则被 startsWith 截胡。
    // 第 4 参数 fullName（可选）：仓库上下文调用点传入 state.repo.full_name；当 path 命中 /repos/<fullName> 前缀时
    // 按该前缀确定性切分（不进词表启发式），用于彻底消除「组名/文件名恰为子资源词」的固有歧义。
    const qi = path.indexOf('?');
    const p = qi >= 0 ? path.slice(0, qi) : path;
    const qs = new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
    const enc = encodeURIComponent;
    const listQs = '&per_page=' + (qs.get('per_page') || 100) + '&page=' + (qs.get('page') || 1);

    let url = null, norm = null, b = body;

    // —— 顶层路径 ——
    if (p === '/user') {
      url = '/user'; norm = 'user';
    } else if (p.startsWith('/user/repos')) {
      // GitHub POST /user/repos → GitLab POST /projects（字段映射）
      if (method === 'POST') {
        url = '/projects';
        b = {
          name: body.name,
          description: body.description || '',
          visibility: body.private ? 'private' : 'public',
          initialize_with_readme: !!body.auto_init,
        };
        norm = 'repo';
      } else {
        url = '/projects?membership=true&simple=false&statistics=true' + listQs + '&order_by=last_activity_at';
        norm = 'repos';
      }
    } else if (/^\/user\/starred\/.+/.test(p) && (method === 'PUT' || method === 'DELETE')) {
      // 收藏/取消收藏：full_name 取 /user/starred/ 之后的「全部段」，支持 GitLab 嵌套组 group/sub/repo
      // （原来的 /^\/user\/starred\/[^/]+\/[^/]+$/ 只认两段，嵌套组会落到下面的 startsWith 列表分支 → 打到列表端点）
      // 必须仍排在 /user/starred 列表分支之前，否则被 startsWith 截胡。
      const full = p.slice('/user/starred/'.length);
      url = '/projects/' + enc(full) + (method === 'PUT' ? '/star' : '/unstar');
    } else if (p.startsWith('/user/starred')) {
      // 收藏列表：翻页参数透传，避免 ≥100 收藏时重复拉第 1 页
      url = '/projects?starred=true&simple=false' + listQs;
      norm = 'repos';
    } else if (p === '/notifications' || p.startsWith('/notifications')) {
      url = '/notifications'; norm = 'unsupported';
    } else if (p.startsWith('/gists')) {
      url = '/gists'; norm = 'unsupported';
    } else if (p.startsWith('/search/repositories')) {
      // GitLab projects API 的合法排序字段是 star_count（GitHub 语义是 stars，勿照搬）
      url = '/projects?search=' + enc(qs.get('q') || '') + '&simple=false&per_page=24&order_by=star_count';
      norm = 'searchrepos';
    } else {
      // —— /repos/{full_name}/{rest} 子路由 ——
      // full_name 支持 GitLab 嵌套组（group/sub/repo）：GitHub 两段式与 GitLab 嵌套组均需被正确解析。
      const parts = p.split('/').filter(Boolean); // ['repos', ...full 段, ...rest 段]
      const SUB_RES = /^(contents|branches|commits|issues|pulls|releases|actions|forks|star|git|labels|tags|milestones|topics)$/;
      let full = null, rest = null;
      if (parts[0] === 'repos' && parts.length >= 3) {
        const prefix = '/repos/' + fullName;
        if (fullName && (p === prefix || p.startsWith(prefix + '/'))) {
          // 仓库上下文调用点（openRepo/loadContents/openFile/…/uploadOne 等）均已显式传入 opts.fullName，
          // 故按「调用方已知的仓库 full_name」确定性切分，**完全不经过词表启发式**。
          // 这彻底消除了自右向左启发式的固有歧义：不再依赖「路径段是否等于子资源词」来猜 full_name 边界——
          // /repos/o/r/contents/contents、/repos/o/r/contents/branches、/repos/o/r/commits/issues、
          // /repos/g1/g2/contents/issues 等都可按 full_name 长度精确切开。
          full = fullName;
          rest = p.slice(prefix.length);
        } else {
          // 无 fullName 提示（或 path 与提示前缀不符）：保持自右向左启发式兜底。
          // 已知固有歧义：当第 2 层及更深的组名、或 /contents/ 下的文件名恰好等于词表词且其后还有子路径时
          // （如 /repos/g1/g2/contents/branches、/repos/o/r/contents/branches），此模式无法完全消歧；
          // 仓库上下文调用点已统一传 opts.fullName 走上方的确定性分支，不会落到此处。
          // 从右往左找「最后一个」子资源词作为切分点，且起点不得早于索引 3：
          // 索引 1/2 是 owner/repo 的位置——仓库名恰好等于词表词时（如 /repos/me/issues 里仓库名 issues），
          // 从左往右切会把「仓库详情」误判成子资源端点；自右向左则让更深的词表命中优先被认作子资源。
          let subIdx = -1;
          for (let i = parts.length - 1; i >= 3; i--) {
            if (SUB_RES.test(parts[i])) { subIdx = i; break; }
          }
          full = subIdx > 0 ? parts.slice(1, subIdx).join('/') : parts.slice(1).join('/');
          rest = subIdx > 0 ? '/' + parts.slice(subIdx).join('/') : '';
        }
        const encd = enc(full);
        const hit = GITLAB._translateRepo(method, rest, encd, qs, b);
        // hit.method 必须回传：_translateRepo 会把「新建文件」由 PUT 改写为 POST（GitLab 语义），漏接收则改写失效
        if (hit) { url = hit.url; b = hit.body; norm = hit.norm; if (hit.method) method = hit.method; }
        else url = '/projects/' + encd + rest; // 兜底：未识别的子路径原样挂到 /projects/{encd} 下
      }
    }
    // 兜底必须返回链上设置好的 url（保持原行为：未匹配任何顶层/仓库分支时 url 回退到原 p，保证非 /repos/* 的路径仍落到当前 GitLab 域名下）
    return { url: url || p, method, body: b, norm };
  },

  // /repos/{owner}/{repo}/{rest} 子路由翻译器。
  // 返回 {url, body, norm} 三元组，或返回 null 表示"未匹配，走兜底"（调用方负责把 rest 拼接到 /projects/{encd} 下）。
  // 匹配顺序：精确匹配优先（避免 /issues 截胡 /issues/123、/releases 截胡 /releases/v1），其次 startsWith 匹配。
  _translateRepo(method, rest, encd, qs, body) {
    const enc = encodeURIComponent;
    const ref = qs.get('ref');
    const glState = qs.get('state') === 'open' ? 'opened' : qs.get('state') === 'closed' ? 'closed' : 'all';

    // 仓库本身（空路径/根路径）
    if (rest === '' || rest === '/') {
      if (method === 'DELETE') return { url: '/projects/' + encd, body, norm: null };
      if (method === 'PATCH') return { url: '/projects/' + encd, body: GITLAB.glPatchRepo(body), norm: 'repo' };
      return { url: '/projects/' + encd, body, norm: 'repo' };
    }
    // Fork
    if (rest === '/forks' && method === 'POST') return { url: '/projects/' + encd + '/fork', body, norm: 'repo' };

    // Contents：tree（目录）| file（读/写/删）
    if (rest.startsWith('/contents')) {
      const after = rest.slice('/contents'.length);
      if (after === '' || after === '/') {
        return { url: '/projects/' + encd + '/repository/tree?per_page=100' + (ref ? '&ref=' + enc(ref) : ''), body, norm: 'tree' };
      }
      const fp = after.slice(1);
      if (method === 'GET') {
        // 调用方已用 encPath 逐段编码（文件路径/ref/分支名均含已编码的 %xx），此处不得二次编码——否则 % → %25 导致 404
        return { url: '/projects/' + encd + '/repository/files/' + fp + (ref ? '?ref=' + ref : ''), body, norm: 'file' };
      }
      if (method === 'PUT' || method === 'POST') {
        // GitHub 的 PUT /contents 是 upsert（创建 + 更新二合一），但 GitLab 的 PUT /repository/files
        // 只用于「更新已存在文件」——创建必须 POST，更新才是 PUT 且带 last_commit_id。
        // 故按「有无 body.sha」拆分方法；本方法的返回值由 translate() 接收并透传（见 translate 内 hit.method）。
        const create = !(body && body.sha);
        return {
          url: '/projects/' + encd + '/repository/files/' + fp,
          method: create ? 'POST' : 'PUT',
          body: {
            branch: (body && body.branch) || 'main',
            content: body ? body.content : '',
            commit_message: body ? body.message : (create ? 'create ' : 'update ') + fp,
            ...(body && body.sha ? { last_commit_id: body.sha } : {}),
            ...(body && body.encoding ? { encoding: body.encoding } : {}),
          },
          norm: null,
        };
      }
      if (method === 'DELETE') {
        // GitLab 删除文件不需要 last_commit_id（可选参数）。调用方传入的 body.sha 来自文件列表
        // tree 接口的 id（blob SHA），与 GitLab last_commit_id 期望的「文件最后 commit SHA」不是同一对象，
        // 传错会导致 400。故此处不映射 last_commit_id，不传则由 GitLab 用当前分支 HEAD 正常删除。
        return {
          url: '/projects/' + encd + '/repository/files/' + fp,
          body: {
            branch: (body && body.branch) || 'main',
            commit_message: body ? body.message : 'delete ' + fp,
          },
          norm: null,
        };
      }
    }

    // Branches
    if (rest === '/branches' && method === 'GET') return { url: '/projects/' + encd + '/repository/branches?per_page=100', body, norm: 'branches' };
    if (rest === '/branches' && method === 'POST') return { url: '/projects/' + encd + '/repository/branches', body: { branch: body.name, ref: body.ref }, norm: null };

    // Git refs：建/删分支
    if (rest === '/git/refs' && method === 'POST') {
      const refName = String((body && body.ref) || '').replace(/^refs\/heads\//, '');
      return { url: '/projects/' + encd + '/repository/branches', body: { branch: refName, ref: (body && body.sha) || 'main' }, norm: null };
    }
    if (rest.startsWith('/git/refs/heads/') && method === 'DELETE') {
      // 分支名调用方已 encodeURIComponent，此处不再编码
      return { url: '/projects/' + encd + '/repository/branches/' + rest.split('/').pop(), body, norm: null };
    }

    // Commits
    if (rest === '/commits') {
      return { url: '/projects/' + encd + '/repository/commits?per_page=30' + (qs.get('sha') ? '&ref_name=' + enc(qs.get('sha')) : ''), body, norm: 'commits' };
    }

    // Issues（list / create / patch / comment）—— /issues 与 /issues/123 必须独立匹配
    if (rest === '/issues' && method === 'GET') return { url: '/projects/' + encd + '/issues?per_page=100&scope=all&state=' + glState, body, norm: 'issues' };
    if (rest === '/issues' && method === 'POST') return { url: '/projects/' + encd + '/issues', body: { title: body.title, description: body.body || '' }, norm: null };
    if (/^\/issues\/\d+$/.test(rest) && method === 'PATCH') {
      return { url: '/projects/' + encd + '/issues/' + rest.split('/')[2], body: { state_event: body.state === 'closed' ? 'close' : 'reopen' }, norm: null };
    }
    if (/^\/issues\/\d+\/comments$/.test(rest) && method === 'POST') {
      return { url: '/projects/' + encd + '/issues/' + rest.split('/')[2] + '/notes', body: { body: body.body }, norm: null };
    }

    // Pulls（MR）
    if (rest === '/pulls') return { url: '/projects/' + encd + '/merge_requests?per_page=50&state=all', body, norm: 'pulls' };
    if (/^\/pulls\/\d+\/files$/.test(rest) && method === 'GET') {
      return { url: '/projects/' + encd + '/merge_requests/' + rest.split('/')[2] + '/changes', body, norm: 'prfiles' };
    }

    // Releases
    if (rest === '/releases' && method === 'GET') return { url: '/projects/' + encd + '/releases', body, norm: 'releases' };
    if (/^\/releases\/[^/]+$/.test(rest) && method === 'DELETE') {
      // ENG-4：调用点（data-rdel）传的是 normalize 时已 encodeURIComponent 一次的 tag，直接拼接即可；
      // 这里不做 decode/re-encode——decode 会让含 % 的 tag 抛 URIError，原始拼接会让含 / 的 tag 路径断裂 404
      return { url: '/projects/' + encd + '/releases/' + rest.split('/')[2], body, norm: null };
    }

    // Actions → Pipelines
    if (rest === '/actions/runs') return { url: '/projects/' + encd + '/pipelines?per_page=20', body, norm: 'pipelines' };

    // Star / Unstar（仓库级）
    if (rest === '/star' && method === 'PUT')    return { url: '/projects/' + encd + '/star',    body, norm: null };
    if (rest === '/star' && method === 'DELETE') return { url: '/projects/' + encd + '/unstar',  body, norm: null };

    return null; // 未识别子路径 → 调用方走兜底
  },

  glPatchRepo(b) {
    const out = {};
    if (b.name !== undefined) { out.name = b.name; }
    if (b.description !== undefined) out.description = b.description;
    if (b.default_branch !== undefined) out.default_branch = b.default_branch;
    if (b.private !== undefined) out.visibility = b.private ? 'private' : 'public';
    if (b.archived !== undefined) out.archived = b.archived;
    return out;
  },
  nRepo(p) {
    const out = {
      id: p.id, name: p.path, full_name: p.path_with_namespace,
      private: p.visibility !== 'public', fork: !!p.forked_from_project,
      archived: !!p.archived, description: p.description || '',
      language: p.language || null, size: p.statistics ? Math.round(p.statistics.repository_size / 1024) : null,
      pushed_at: p.last_activity_at, stargazers_count: p.star_count ?? 0,
      html_url: p.web_url, default_branch: p.default_branch || 'main',
      viewer_has_starred: undefined, forks_count: p.forks_count ?? 0,
      open_issues_count: p.open_issues_count ?? 0,
    };
    out.permissions_admin = !!(p.permissions && (
      (p.permissions.project_access && p.permissions.project_access.access_level >= 40) ||
      (p.permissions.group_access && p.permissions.group_access.access_level >= 40)));
    return out;
  },
  normalize(data, norm) {
    if (data === null || data === undefined) return data;
    switch (norm) {
      case 'user': {
        const u = data;
        return { login: u.username, name: u.name, bio: u.bio || '', avatar_url: u.avatar_url, html_url: u.web_url, public_repos: null, total_private_repos: null, followers: null, following: null };
      }
      case 'repos': return (Array.isArray(data) ? data : []).map(p => GITLAB.nRepo(p));
      case 'searchrepos': return { items: (Array.isArray(data) ? data : []).map(p => GITLAB.nRepo(p)) };
      case 'repo': return GITLAB.nRepo(data);
      case 'tree': return (data || []).map(e => ({ name: e.name, path: e.path, type: e.type === 'tree' ? 'dir' : 'file', size: null, sha: e.id }));
      case 'file': {
        const f = data;
        return { name: f.file_name, path: f.file_path, sha: f.last_commit_id, size: f.size, encoding: 'base64', content: f.content || '', html_url: null, download_url: null };
      }
      case 'branches': return (data || []).map(b => ({ name: b.name, commit: { sha: (b.commit && b.commit.id) || '' }, merged: !!b.merged, default: !!b.default }));
      case 'commits': return (data || []).map(c => ({
        sha: c.id, html_url: c.web_url,
        commit: { message: c.message || '', author: { name: c.author_name, date: c.committed_date || c.created_at } },
        author: { login: c.author_name },
      }));
      case 'issues': return (data || []).filter(x => !x.merge_request).map(x => ({
        number: x.iid, title: x.title, state: x.state === 'opened' ? 'open' : 'closed',
        user: { login: x.author ? x.author.username : '' }, created_at: x.created_at,
        comments: x.user_notes_count ?? 0, labels: (x.labels || []).map(l => ({ name: typeof l === 'string' ? l : l.name, color: '6d8cff' })),
        html_url: x.web_url,
      }));
      case 'pulls': return (data || []).map(x => ({
        number: x.iid, title: x.title, state: x.state === 'opened' ? 'open' : x.state,
        merged: !!x.merged_at, merged_at: x.merged_at || null, user: { login: x.author ? x.author.username : '' },
        head: { ref: x.source_branch }, base: { ref: x.target_branch },
        updated_at: x.updated_at, html_url: x.web_url,
      }));
      case 'releases': return (data || []).map(x => ({
        // ENG-4：GitLab 的 Release 以 tag 为 id，含 / 或 % 的 tag 原样放行会破坏 DELETE 路径——
        // 预编码一次存入 id 供删除链接使用，tag_name 字段保持原值供显示
        id: encodeURIComponent(x.tag_name), tag_name: x.tag_name, name: x.name || x.tag_name,
        prerelease: false, draft: false, published_at: x.released_at || x.created_at,
        author: { login: x.author ? (x.author.username || x.author.name) : '' },
        assets: { length: (x.assets && x.assets.sources ? x.assets.sources.length : 0) },
        html_url: (x._links && x._links.self) || x.web_url,
      }));
      case 'prfiles': return (data && data.changes ? data.changes : []).map(x => ({
        filename: x.new_path, status: x.new_file ? 'added' : x.deleted_file ? 'removed' : 'modified',
        additions: null, deletions: null, patch: x.diff || '',
      }));
      case 'pipelines': return {
        workflow_runs: (data || []).map(x => ({
          id: x.id, name: x.ref, display_title: 'Pipeline #' + x.id,
          status: x.status === 'success' ? 'completed' : x.status === 'failed' ? 'completed' : x.status === 'running' ? 'in_progress' : x.status === 'pending' ? 'queued' : 'completed',
          conclusion: x.status === 'success' ? 'success' : x.status === 'failed' ? 'failure' : x.status === 'canceled' ? 'cancelled' : null,
          event: 'pipeline', head_branch: x.ref, run_number: x.id,
          created_at: x.created_at, html_url: x.web_url,
        })),
      };
      default: return data;
    }
  },
};

/* ---------- 桥接调用（带一次性令牌，P1 修复） ---------- */
function bridgeURL(action, extra) {
  const tk = decodeURIComponent((location.hash || '').replace(/^#/, '')).replace(/^tk=/, '');
  return '/bridge?action=' + action + (extra || '') + '&tk=' + encodeURIComponent(tk);
}

/* ---------- GET 响应 ETag 缓存（命中 304 不计费，省 rate limit） ---------- */
const apiCache = new Map();
const API_CACHE_MAX = 120;

/* ---------- 并发限流执行器（批量操作防触发平台二级限流） ---------- */
async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = { ok: true, value: await worker(items[i], i) }; }
      catch (e) { results[i] = { ok: false, error: e }; }
    }
  };
  const lanes = Math.max(1, Math.min(limit || 4, items.length));
  await Promise.all(Array.from({ length: lanes }, run));
  return results;
}

/* ---------- 统一 API 入口（平台感知） ---------- */
function updateRate(resp, gen) {
  const h = (n) => resp.headers.get(n);
  // GitHub 通过响应头 X-OAuth-Scopes 暴露当前 Token 的权限，存入 state（供 requireScopes 判断）。
  // 依据：GitHub 官方 CORS 文档明列 Access-Control-Expose-Headers 含 X-OAuth-Scopes
  // （docs.github.com/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests），
  // 故跨域下该头确实可被渲染进程读出——requireScopes 是真实现，非空壳。
  // GitLab / Gitee / GitCode 无等价的权限响应头（拿不到）→ 不写入，requireScopes 据此返回 null
  // → 对外表现为「该平台横幅不显示」，属平台能力差异下的诚实降级，不编造。
  const scopes = h('X-OAuth-Scopes');
  // C-8：切账号后，在途请求的旧 scopes 不得写回（否则 requireScopes 横幅按上一个账号误判）
  if (scopes !== null && (gen === undefined || gen === state.reqGen)) state.tokenScopes = scopes.split(',').map(s => s.trim()).filter(Boolean);
  const rem = h('X-RateLimit-Remaining') ?? h('RateLimit-Remaining');
  const lim = h('X-RateLimit-Limit') ?? h('RateLimit-Limit');
  const reset = h('X-RateLimit-Reset') ?? h('RateLimit-Reset');
  if (rem !== null && $('#rate-line')) {
    // 响应头值不进 innerHTML（textContent 不可注入，防头注入 XSS）
    const el = $('#rate-line');
    el.textContent = 'API 余量 ' + rem + ' / ' + (lim ?? '?') + (reset ? ' · 重置于 ' + new Date(Number(reset) * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '');
  }
}
async function api(method, path, body, opts) {
  const acct = activeAccount();
  if (!acct) throw new Error('未绑定任何平台账号');
  const P = PLATFORMS[acct.platform];
  const headers = Object.assign({ 'Accept': 'application/json' }, P.auth(acct.token));
  let sendBody = body;
  let norm = null;
  // Gitee / GitCode 无 GitHub 的 /git/refs 端点（git data API），建/删分支需改写为其 /branches 端点：
  //   建分支 POST /repos/{o}/{r}/branches，body { branch_name, refs }（refs 为源分支/commit）；
  //   删分支 DELETE /repos/{o}/{r}/branches/{branch}。
  if (acct.platform === 'gitee' || acct.platform === 'gitcode') {
    let m;
    if (method === 'POST' && (m = path.match(/^(\/repos\/[^/]+\/[^/]+)\/git\/refs$/))) {
      const bn = String((sendBody && sendBody.ref) || '').replace(/^refs\/heads\//, '');
      path = m[1] + '/branches';
      sendBody = { branch_name: bn, refs: (sendBody && sendBody.sha) || '' };
    } else if (method === 'DELETE' && (m = path.match(/^(\/repos\/[^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/))) {
      path = m[1] + '/branches/' + m[2];
    }
  }
  let url = P.apiBase + path;
  // Gitee / GitCode 的 contents 写接口与 GitLab 同构（两者官方文档均确认）：
  //   新建文件 = POST /repos/{o}/{r}/contents/{path}；更新文件 = PUT 且必须带 sha。
  // 本项目调用方沿用 GitHub 的「PUT 兼做创建+更新」语义，故此处对「无 sha 的写文件请求」同构改写为 POST。
  // （仅命中 /contents/ 写路径；目录列举是 GET，不受影响。）
  if ((acct.platform === 'gitee' || acct.platform === 'gitcode') &&
      method === 'PUT' && /\/contents\//.test(path) && !(sendBody && sendBody.sha)) {
    method = 'POST';
  }
  if (acct.platform === 'gitlab') {
    // opts.fullName：仓库上下文调用点传入 state.repo.full_name，供 translate 对 /repos/* 路径做确定性切分
    const t = GITLAB.translate(method, path, body, opts && opts.fullName);
    url = P.apiBase + t.url;
    method = t.method; sendBody = t.body; norm = t.norm;
    if (t.norm === 'unsupported') throw new Error('GitLab 平台暂不支持此功能');
  }
  // 30s 超时：平台 API 假死（代理半连接等）时不再永久挂起骨架屏
  const opt = { method, headers, signal: AbortSignal.timeout(30000) };
  if (sendBody !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(sendBody); }
  const cacheable = method === 'GET';
  // 缓存键含账号指纹（token 末 8 位）：同平台多账号互不踩缓存，也不跨账号驻留数据
  const acctFp = acct.platform + '#' + (acct.token || '').slice(-8);
  const cacheKey = cacheable ? (acctFp + ':' + url) : '';
  if (cacheable) {
    const hit = apiCache.get(cacheKey);
    if (hit && hit.etag) headers['If-None-Match'] = hit.etag;
  }
  let resp = null;
  const reqGen = state.reqGen; // C-8：请求发起时的代际，供 updateRate 校验（切账号后旧 scopes 不写回）
  for (let attempt = 0; attempt < 2; attempt++) {
    try { resp = await fetch(url, opt); }
    catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || /aborted|timeout/i.test(String(e.message || '')));
      throw new Error(timedOut ? '请求超时（30 秒无响应），请检查网络或代理设置' : '网络请求失败，请检查网络连接');
    }
    updateRate(resp, reqGen);
    if (resp.status === 204) return null;
    if (resp.status === 304 && cacheable && apiCache.has(cacheKey)) {
      return apiCache.get(cacheKey).data;
    }
    if (resp.status === 304 && attempt === 0) {
      // 缓存条目已被 LRU 逐出：去掉条件请求头强制重拉，而不是落到错误分支报 "HTTP 304"
      delete headers['If-None-Match'];
      continue;
    }
    if (resp.status === 304) {
      // C-7：二次 304（正常语义下不应发生，仅服务端/代理异常时可达）——给可读错误而非裸 "HTTP 304"
      throw new Error('服务端缓存异常（HTTP 304），请稍后重试');
    }
    break;
  }
  let data = null;
  try { data = await resp.json(); } catch (e) {}
  if (resp.ok) {
    let out = data;
    if (acct.platform === 'gitlab' && norm) out = GITLAB.normalize(data, norm);
    // GitCode v5 仓库对象缺 html_url/archived/size（2026-09-15 实测）：轻量补默认值，
    // 否则「网页」链接为空、归档徽章逻辑失效；有 full_name 的对象才视为仓库形态
    if (acct.platform === 'gitcode' && out && typeof out === 'object') {
      const gcFix = (r) => {
        if (!r || typeof r !== 'object' || Array.isArray(r) || !r.full_name) return;
        if (!r.html_url) r.html_url = r.web_url || ('https://gitcode.com/' + r.full_name);
        if (r.archived === undefined) r.archived = false;
        if (r.size === undefined) r.size = null;
      };
      if (Array.isArray(out)) out.forEach(gcFix); else gcFix(out);
    }
    if (cacheable) {
      const et = resp.headers.get('ETag');
      if (et) {
        if (apiCache.size >= API_CACHE_MAX) apiCache.delete(apiCache.keys().next().value);
        apiCache.set(cacheKey, { etag: et, data: out });
      }
    }
    return out;
  }
  const msg = data && (data.message || data.error) ? (data.message || data.error) : ('HTTP ' + resp.status);
  if (resp.status === 401) { logout('当前平台的 Token 已失效，请重新登录'); }
  const err = new Error(msg); err.status = resp.status; throw err;
}
function requireScopes() {
  // 仅 GitHub 通过响应头 X-OAuth-Scopes 暴露 Token 权限（updateRate 已存入 state.tokenScopes）；
  // 该头确在 GitHub CORS 的 Access-Control-Expose-Headers 白名单内（见 updateRate 注释所引官方文档），
  // 故 GitHub 分支是真实现。GitLab / Gitee / GitCode 无等价信息 → 返回 null；对外表现为
  // 「该平台无法获取该权限信息，横幅不显示」，属平台能力差异下的诚实降级，
  // 而非「有入口、有提示、底层却不生效」的空壳。
  const acct = activeAccount();
  if (!acct || acct.platform !== 'github') return null;
  if (!Array.isArray(state.tokenScopes)) return null; // 尚未收到任何带 scope 头的响应，不误报
  if (state.tokenScopes.includes('delete_repo')) return null;
  return '当前 GitHub Token 未勾选 delete_repo 权限，删除仓库会失败。请到 GitHub 重新生成 Token 并勾选 delete_repo 后再试。';
}


'use strict';
/* ================================================================
   Git 控制台 —— 多平台 Git 管理台（GitHub / GitLab / Gitee / GitCode）
   平台适配与账号管理见 part_adapters
   ================================================================ */

const state = {
  user: null, theme: 'light', loginPlatform: 'github', tokenScopes: null,
  accounts: [], activeIdx: -1, reqGen: 0, starredSet: new Set(),
  repos: [], reposLoaded: false,
  selected: new Set(), filter: 'all', query: '',
  stars: [], starsLoaded: false,
  notifications: [], notifLoaded: false, notifAll: false, notifCount: 0,
  gists: [], gistsLoaded: false,
  searchResults: null, searchQuery: '', searching: false,
  repo: null, branches: [], branch: null,
  tab: 'files', path: '', file: null,
  commits: [], issues: [], issueFilter: 'open',
  pulls: [], releases: [], runs: [],
};

/* ---------------- 工具 ---------------- */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function fmtSize(kb){ if (kb == null) return '-'; return kb >= 1024 ? (kb/1024).toFixed(1) + ' MB' : kb + ' KB'; }
function timeAgo(iso){
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s/60) + ' 分钟前';
  if (s < 86400) return Math.floor(s/3600) + ' 小时前';
  if (s < 2592000) return Math.floor(s/86400) + ' 天前';
  return iso.slice(0, 10);
}
const LANG_COLORS = {
  JavaScript:'#f1e05a', TypeScript:'#3178c6', Python:'#3572A5', Java:'#b07219',
  Go:'#00ADD8', Rust:'#dea584', C:'#555555', 'C++':'#f34b7d', 'C#':'#178600',
  HTML:'#e34c26', CSS:'#563d7c', Vue:'#41b883', Shell:'#89e051', Markdown:'#083fa1',
  'Jupyter Notebook':'#DA5B0B', Kotlin:'#A97BFF', PHP:'#4F5D95', Ruby:'#701516', Swift:'#F05138',
  Dart:'#00B4AB', Lua:'#000080', 'Objective-C':'#438eff', Scala:'#c22d40', Zig:'#ec915c',
};
const langColor = l => LANG_COLORS[l] || '#9aa4b8';
const IMG_EXT = ['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif'];

function encPath(p){
  const segs = p.split('/');
  if (segs.some(seg => seg === '..' || seg === '.')) throw new Error('路径不能包含 . 或 ..');
  return segs.map(encodeURIComponent).join('/');
}
function utf8ToB64(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function b64ToUtf8(b64){
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---------------- 图标 ---------------- */
function icon(name, size){
  size = size || 16;
  const S = 'stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  const p = {
    home:'<path d="M4 11l8-7 8 7v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8z" ' + S + '/>',
    repo:'<path d="M5 3.5h12.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H7A2.5 2.5 0 0 1 4.5 16V5a1.5 1.5 0 0 1 .5-1.5zM7 16h11.5" ' + S + '/>',
    star:'<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8L12 3.5z" ' + S + '/>',
    starFill:'<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8L12 3.5z" fill="currentColor"/>',
    bell:'<path d="M12 4a5 5 0 0 0-5 5v3.4l-1.5 2.8a.8.8 0 0 0 .7 1.2h11.6a.8.8 0 0 0 .7-1.2L17 12.4V9a5 5 0 0 0-5-5zM10 18.7a2 2 0 0 0 4 0" ' + S + '/>',
    search:'<circle cx="10.5" cy="10.5" r="6" ' + S + '/><path d="M15 15l5.2 5.2" ' + S + '/>',
    code:'<path d="M8.5 7L4 12l4.5 5M15.5 7L20 12l-4.5 5" ' + S + '/>',
    gear:'<circle cx="12" cy="12" r="3.2" ' + S + '/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.35a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" ' + S + '/>',
    logout:'<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9M14 8l4 4-4 4M18 12H9" ' + S + '/>',
    folder:'<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" fill="currentColor" opacity=".8"/>',
    file:'<path d="M6 2h6l4 4v12a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 18V3.5A1.5 1.5 0 0 1 5.5 2H6z" ' + S + '/><path d="M12 2v4h4" ' + S + '/>',
    branch:'<circle cx="6" cy="5" r="2.1" fill="currentColor"/><circle cx="6" cy="19" r="2.1" fill="currentColor"/><circle cx="18" cy="7" r="2.1" fill="currentColor"/><path d="M6 7.2v9.6M18 9.2c0 4-4 4.5-9 5" ' + S + '/>',
    issue:'<circle cx="12" cy="12" r="8.5" ' + S + '/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    pr:'<circle cx="6.5" cy="6" r="2.1" fill="currentColor"/><circle cx="6.5" cy="18" r="2.1" fill="currentColor"/><circle cx="17.5" cy="18" r="2.1" fill="currentColor"/><path d="M6.5 8.2v7.6M15.5 16.5v-6a4 4 0 0 0-4-4H9.5M12 4l-2.5 2.5L12 9" ' + S + '/>',
    commit:'<circle cx="12" cy="12" r="3.4" ' + S + '/><path d="M2 12h6.4M15.6 12H22" ' + S + '/>',
    fork:'<circle cx="7" cy="5.5" r="2" fill="currentColor"/><circle cx="17" cy="5.5" r="2" fill="currentColor"/><circle cx="12" cy="18.5" r="2" fill="currentColor"/><path d="M7 7.6v1.4a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V7.6M12 12v4.4" ' + S + '/>',
    trash:'<path d="M5 7h14M10 7V5h4v2M8.5 7l.7 12h5.6l.7-12M10.5 10.5l.2 5M13.5 10.5l-.2 5" ' + S + '/>',
    plus:'<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    refresh:'<path d="M19 12a7 7 0 1 1-2-4.9M19 3.5V8h-4.5" ' + S + '/>',
    back:'<path d="M14.5 5.5L8 12l6.5 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    ext:'<path d="M9 5h10v10M19 5L8 16" ' + S + '/>',
    eye:'<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" ' + S + '/><circle cx="12" cy="12" r="2.8" fill="currentColor"/>',
    edit:'<path d="M4 20l4.3-1L20 7.3 16.7 4 5.3 15.7 4 20z" ' + S + '/>',
    comment:'<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9.5L4 20V6z" ' + S + '/>',
    tag:'<path d="M4 4.8A.8.8 0 0 1 4.8 4h6.4a1 1 0 0 1 .7.3l8 8a1 1 0 0 1 0 1.4l-6.2 6.2a1 1 0 0 1-1.4 0l-8-8a1 1 0 0 1-.3-.7V4.8z" ' + S + '/><circle cx="8.3" cy="8.3" r="1.5" fill="currentColor"/>',
    zap:'<path d="M13 2L5 13.2h5.2L9 22l8-11.2h-5.2L13 2z" ' + S + '/>',
    archive:'<rect x="4" y="4" width="16" height="5" rx="1" ' + S + '/><path d="M6 9v9a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 18V9M10 13h4" ' + S + '/>',
    download:'<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" ' + S + '/>',
    check:'<path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    x:'<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
    moon:'<path d="M20.5 13.5A8.5 8.5 0 0 1 10.5 3.5a8.5 8.5 0 1 0 10 10z" ' + S + '/>',
    sun:'<circle cx="12" cy="12" r="4" ' + S + '/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" ' + S + '/>',
  }[name] || '';
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" style="flex:none">' + p + '</svg>';
}

/* ---------------- Toast / Modal ---------------- */
function toast(msg, type){
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'ok');
  t.innerHTML = icon(type === 'err' ? 'x' : 'check', 15) + '<span>' + esc(msg) + '</span>';
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 450); }, 3400);
}
function openModal(html){ $('#modal').innerHTML = html; $('#modal-mask').classList.remove('hidden'); }
function closeModal(){ $('#modal-mask').classList.add('hidden'); $('#modal').innerHTML = ''; }
$('#modal-mask').addEventListener('mousedown', e => { if (e.target.id === 'modal-mask') closeModal(); });

/* 通用确认：需要输入指定文字 */
function confirmModal(opts){
  const need = opts.required;
  openModal(`
    <div class="m-title danger">${esc(opts.title)}</div>
    <p class="m-text">${opts.bodyHtml != null ? opts.bodyHtml : esc(opts.body)}</p>
    ${opts.list ? '<div class="m-list">' + opts.list.map(n => '<div>' + esc(n) + '</div>').join('') + '</div>' : ''}
    <p class="m-text">请完整输入 <b style="font-family:var(--mono)">${esc(need)}</b> 以确认：</p>
    <input class="m-input" id="cm-input" autocomplete="off">
    <div class="m-actions">
      <button class="btn" id="cm-cancel">取消</button>
      <button class="btn danger" id="cm-ok" disabled>${esc(opts.okText || '确认')}</button>
    </div>
  `);
  const input = $('#cm-input'), ok = $('#cm-ok');
  input.focus();
  input.addEventListener('input', () => { ok.disabled = input.value.trim() !== need; });
  $('#cm-cancel').addEventListener('click', closeModal);
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try { await opts.onConfirm(); closeModal(); }
    catch (e) { toast('操作失败：' + e.message, 'err'); ok.disabled = false; }
  });
}

/* ---------------- 主题 ---------------- */
function applyTheme(){
  document.body.classList.toggle('dark', state.theme === 'dark');
  const btn = $('#tb-theme');
  if (btn) {
    btn.innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon');
    btn.title = state.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
  }
}
function toggleTheme(){
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('ghc_theme', state.theme);
  applyTheme();
  try { fetch(bridgeURL('theme', '&dark=' + (state.theme === 'dark' ? '1' : '0'))).catch(() => {}); } catch (e) {}
}
$('#tb-theme').addEventListener('click', toggleTheme);
$('#tb-home').addEventListener('click', () => showView('overview'));
$('#tb-platform').addEventListener('click', (e) => {
  e.stopPropagation();
  renderPlatformMenu();
  const menu = $('#tb-menu');
  const r = e.currentTarget.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.round(r.left - 8)) + 'px';
  menu.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  const menu = $('#tb-menu');
  if (menu.classList.contains('open') && !menu.contains(e.target) && e.target.id !== 'tb-platform' && !e.target.closest('#tb-platform')) closeTbMenu();
});

/* api / updateRate / requireScopes 已移至平台适配层 */

/* ---------------- 登录（多平台） ---------------- */
let loginPlatform = 'github';
function renderLoginPlatforms(){
  // 同步 state.loginPlatform：loginPing 读它来选探测目标，此前它恒为 'github'，选 GitLab/Gitee/GitCode 后网络状态区仍探 GitHub
  state.loginPlatform = loginPlatform;
  $('#login-platforms').innerHTML = Object.keys(PLATFORMS).map(k =>
    '<button class="plat-chip ' + (loginPlatform === k ? 'active' : '') + '" data-lp="' + k + '">' + PLATFORMS[k].label + '</button>').join('');
  const P = PLATFORMS[loginPlatform];
  $('#login-token-url').href = P.tokenUrl;
  $('#login-token-hint').textContent = P.tokenHint;
  $('#token-input').placeholder = loginPlatform === 'github' ? 'ghp_ 开头的 Classic Token' : 'Personal Access Token';
  $$('#login-platforms .plat-chip').forEach(b => b.addEventListener('click', () => {
    loginPlatform = b.dataset.lp;
    renderLoginPlatforms();
    loginPing(); // 平台切换后按新平台重新探测，避免状态区显示旧平台的结论
  }));
}
/* ================= 登录页网络诊断与代理 ================= */
function loginPing(){
  const el = $('#net-status');
  if (!el) return;
  // 按当前选中平台探测对应 API 域（主进程白名单校验 host）
  const P = PLATFORMS[state.loginPlatform || 'github'] || PLATFORMS.github;
  let host = 'api.github.com';
  try { host = new URL(P.apiBase).host; } catch (e) {}
  el.textContent = '正在检测 ' + P.label + ' 连接 ...';
  fetch(bridgeURL('ping'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host }),
  }).then(r => r.json()).then(d => {
    el.textContent = d.ok
      ? '✓ ' + P.label + ' 连接正常（' + d.ms + 'ms），可以直接登录'
      : '✗ ' + P.label + ' 无法访问 —— 请开启代理客户端，或点「网络设置 / 自动探测代理」配置';
  }).catch(() => { el.innerHTML = ''; });
}
function openLoginNetModal(){
  openModal(`
    <div class="m-title">网络设置</div>
    <p class="m-text">GitHub 连不上时配置代理。肥猫云 / Clash / V2Ray 等客户端会开一个本地端口（可点「自动探测端口」找）。</p>
    <div class="chips" id="ln-chips">
      <button class="chip" data-pv="system">跟随系统</button>
      <button class="chip" data-pv="direct">直连</button>
      <button class="chip" data-pv="custom">自定义代理</button>
    </div>
    <div class="form-row" style="margin-top:12px">
      <div class="m-field" style="flex:1;min-width:220px">
        <input class="m-input" id="ln-input" placeholder="例如 127.0.0.1:7890" style="font-family:var(--mono)">
      </div>
      <button class="btn" id="ln-probe">自动探测端口</button>
    </div>
    <div id="ln-probe-result" style="font-size:12px;color:var(--muted);margin-bottom:10px"></div>
    <div class="m-actions">
      <button class="btn" id="ln-cancel">取消</button>
      <button class="btn primary" id="ln-save">保存并测试</button>
    </div>
    <div id="ln-status" style="font-size:12.5px;color:var(--muted);margin-top:8px"></div>
  `);
  let cur = 'system';
  const syncUI = () => {
    const custom = cur !== 'system' && cur !== 'direct';
    $$('#ln-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.pv === (custom ? 'custom' : cur)));
    $('#ln-input').value = custom ? cur : '';
  };
  fetch(bridgeURL('getproxy')).then(r => r.json()).then(d => { cur = d.proxy || 'system'; syncUI(); }).catch(() => {});
  $$('#ln-chips .chip').forEach(c => c.addEventListener('click', () => {
    cur = c.dataset.pv;
    syncUI();
    if (cur === 'custom') $('#ln-input').focus();
  }));
  $('#ln-cancel').addEventListener('click', closeModal);
  $('#ln-probe').addEventListener('click', () => {
    const el = $('#ln-probe-result');
    el.textContent = '正在探测本机代理端口 ...';
    fetch(bridgeURL('probe-ports')).then(r => r.json()).then(d => {
      el.innerHTML = d.ports.length
        ? '发现本机代理端口：' + d.ports.map(p => '<button class="chip" data-port="' + esc(p) + '" style="margin:2px">' + esc(p) + '</button>').join(' ') + '（点击选用）'
        : '未发现常见代理端口 —— 请确认代理客户端已开启，或手动填写端口';
      $$('#ln-probe-result [data-port]').forEach(b => b.addEventListener('click', () => {
        cur = '127.0.0.1:' + b.dataset.port;
        $('#ln-input').value = cur;
        syncUI();
      }));
    }).catch(() => { el.textContent = '探测失败'; });
  });
  $('#ln-save').addEventListener('click', () => {
    const v = cur === 'custom' ? $('#ln-input').value.trim() : cur;
    if (cur === 'custom' && !v) { $('#ln-status').textContent = '请填写代理地址'; return; }
    const st = $('#ln-status');
    st.textContent = '正在应用代理 ...';
    fetch(bridgeURL('setproxy', '&value=' + encodeURIComponent(v))).then(r => r.json()).then(d => {
      // 按主进程真实结果反馈：应用失败时不再假装进入「测试连接」
      if (!d || !d.ok) { st.textContent = '✗ 代理应用失败：' + ((d && d.error) || '未知错误'); return; }
      st.textContent = '已保存，正在测试 GitHub 连接 ...';
      return fetch(bridgeURL('ping')).then(r => r.json()).then(dd => {
        st.innerHTML = dd.ok
          ? '✓ GitHub 连接正常（' + dd.ms + 'ms）—— 现在可以登录了'
          : '✗ 仍然连不上：' + esc(dd.error || 'HTTP ' + dd.status) + ' —— 换个端口或确认代理客户端在运行';
        if (dd.ok) loginPing();
      });
    }).catch(() => { st.textContent = '测试失败'; });
  });
}
$('#login-net-btn').addEventListener('click', openLoginNetModal);

async function tryLogin(platform, token){
  const P = PLATFORMS[platform];
  const btn = $('#login-btn');
  btn.disabled = true; btn.textContent = '正在验证 ...';
  $('#login-err').innerHTML = '';
  try {
    // Gitee 认证走 Authorization: token 头（api() 已对齐），不再拼 access_token query
    const loginUrl = P.apiBase + '/user';
    const resp = await fetch(loginUrl, { headers: Object.assign({ 'Accept': 'application/json' }, P.auth(token)), signal: AbortSignal.timeout(30000) });
    updateRate(resp);
    if (!resp.ok) throw new Error(resp.status === 401 ? 'Token 无效或已过期，请检查后重试' : P.label + ' 返回 ' + resp.status);
    let u = await resp.json();
    if (platform === 'gitlab') u = GITLAB.normalize(u, 'user');
    state.user = u;
    addAccount(platform, token, P.label + ' · ' + (u.login || '账号'));
    state.repos = []; state.reposLoaded = false;
    state.stars = []; state.starsLoaded = false;
    enterShell(u); // 把已拿到的 u 交给 enterShell，避免 resetSession 清空后再重复拉一次 /user
  } catch (e) {
    let msg = e.message;
    if (e && (e.name === 'TimeoutError' || /aborted|timeout/i.test(String(e.message || ''))))
      msg = '登录验证超时（30 秒无响应），请检查网络或代理设置后重试';
    else if (/failed to fetch|网络请求失败/i.test(msg))
      msg += ' —— 无法连接 ' + P.label + '：请确认代理客户端已开启，或点上方「网络设置」更换代理';
    $('#login-err').innerHTML = esc(msg);
  } finally {
    btn.disabled = false; btn.textContent = '进入控制台';
  }
}
// 会话级状态集中清理：登录成功 / 登出 / 切账号统一走这里。
// 此前逐字段手抄清理清单，已连续遗漏 selected、apiCache、starredSet 三次——收敛到单点。
function resetSession(){
  state.user = null;
  state.tokenScopes = null; // Token 权限随账号变化，切号/登出后作废（requireScopes 横幅据此重判）
  state.repos = []; state.reposLoaded = false;
  state.selected.clear(); state.filter = 'all'; state.query = '';
  state.stars = []; state.starsLoaded = false;
  state.starredSet = new Set();
  state.notifications = []; state.notifLoaded = false; state.notifAll = false; state.notifCount = 0;
  state.gists = []; state.gistsLoaded = false;
  state.searchResults = null; state.searchQuery = ''; state.searching = false;
  state.repo = null; state.branches = []; state.branch = null;
  state.tab = 'files'; state.path = ''; state.file = null;
  state.commits = []; state.issues = []; state.issueFilter = 'open';
  state.pulls = []; state.releases = []; state.runs = [];
  apiCache.clear(); // 响应缓存：防跨账号驻留与 ETag 互踩
  state.reqGen++;   // 作废所有在途加载（代际守卫会让旧响应静默退出）
}
function logout(msg){
  resetSession();
  $('#shell').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
  renderLoginPlatforms();
  loginPing();
  if (msg) $('#login-err').innerHTML = esc(msg);
}
$('#login-btn').addEventListener('click', () => {
  const t = $('#token-input').value.trim();
  if (!t) { $('#login-err').innerHTML = '请先粘贴 Token'; return; }
  tryLogin(loginPlatform, t);
});
$('#token-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#login-btn').click(); });
$('#logout-btn').addEventListener('click', () => logout(''));

/* ---------------- 导航 ---------------- */
const NAV = [
  ['overview', '总览', 'home'],
  ['repos', '我的仓库', 'repo'],
  ['stars', '我的收藏', 'star'],
  ['notifications', '通知', 'bell'],
  ['search', '搜索', 'search'],
  ['gists', '代码片段', 'code'],
  ['settings', '设置', 'gear'],
];
let currentView = 'overview';
function renderNav(){
  $('#side-nav').innerHTML = NAV.map(([k, label, ic]) => {
    const badge = (k === 'notifications' && state.notifCount) ? '<span class="nav-badge">' + (state.notifCount > 99 ? '99+' : state.notifCount) + '</span>' : '';
    return '<button class="nav-item ' + (currentView === k ? 'active' : '') + '" data-nav="' + k + '">' +
      icon(ic) + '<span>' + label + '</span>' + badge + '</button>';
  }).join('');
  $$('#side-nav [data-nav]').forEach(b => b.addEventListener('click', () => showView(b.dataset.nav)));
}
async function refreshNotifCount(){
  const P = activePlatform();
  if (!P || !P.caps.notifications) { state.notifCount = 0; renderNav(); return; }
  const gen = state.reqGen; // 代际守卫：切账号/登出后晚到的响应不写回
  try {
    const list = await api('GET', '/notifications?per_page=50');
    if (gen !== state.reqGen) return;
    state.notifCount = list.length;
  } catch (e) { if (gen === state.reqGen) state.notifCount = 0; }
  if (gen === state.reqGen) renderNav();
}
// 视图加载注册表：每个视图一个 loader，showView 只负责切换与派发
const VIEW_LOADERS = {
  overview: () => renderOverview(),
  repos: () => { renderRepos(); if (!state.reposLoaded && activeAccount()) loadRepos(); }, // ENG-6 连带：openRepo 提前 ++reqGen 会作废在途 loadRepos，未加载完成时进入视图自动重拉（loadRepos 内部代际自会收敛重复请求）
  stars: () => { if (!state.starsLoaded) loadStars(); },
  notifications: () => {
    const P = activePlatform();
    if (!P || !P.caps.notifications) return renderUnsupported('通知', P);
    loadNotifications();
  },
  gists: () => {
    if (state.gistsLoaded) return;
    const P = activePlatform();
    if (!P || !P.caps.gists) return renderUnsupported('Gists', P);
    loadGists();
  },
  search: () => renderSearch(),
  settings: () => renderSettings(),
};
function showView(name){
  currentView = name;
  ['overview','repos','stars','notifications','search','gists','settings','repo'].forEach(v => {
    const el = $('#view-' + v);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  renderNav();
  $('#main').scrollTop = 0;
  const loader = VIEW_LOADERS[name];
  if (loader) loader();
}
function renderUnsupported(what, P){
  const view = what === '通知' ? 'notifications' : 'gists';
  $('#view-' + view).innerHTML =
    '<div class="page-head"><div class="page-title">' + icon('issue') + ' ' + esc(what) + '</div></div>' +
    '<div class="card empty">' + icon('issue', 40) +
    '<div class="big">' + esc(P ? P.label : '当前平台') + ' 暂不支持' + esc(what) + '</div>' +
    '<div>切换到其他平台后可用，或在顶栏切换账号</div></div>';
}
function renderTopbar(){
  const a = activeAccount();
  const P = a ? PLATFORMS[a.platform] : null;
  $('#tb-platform-label').textContent = a ? (P.label + ' · ' + (state.user ? (state.user.login || a.label) : a.label)) : '未绑定';
  const tb = $('#tb-theme');
  if (tb) {
    tb.innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon');
    tb.title = state.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
  }
  const th = $('#tb-home');
  if (th) th.innerHTML = icon('home');
}
function renderPlatformMenu(){
  const menu = $('#tb-menu');
  menu.innerHTML = '<div class="menu-head">已绑定的平台账号（点击切换）</div>' +
    (state.accounts.length
      ? state.accounts.map((a, i) => {
          const P = PLATFORMS[a.platform];
          return '<div class="acct ' + (i === state.activeIdx ? 'active' : '') + '" data-ai="' + i + '">' +
            '<span class="dot" style="background:var(--accent)"></span><span>' + esc(P.label) + '</span>' +
            '<span style="color:var(--subtle);font-size:11.5px;flex:1;text-align:right">' + esc((a.label || '').split('·').pop().trim()) + '</span>' +
            (i === state.activeIdx ? '<span class="badge def">当前</span>' : '') + '</div>';
        }).join('')
      : '<div class="acct" style="color:var(--muted)">还没有绑定账号</div>') +
    '<div class="menu-foot"><button class="btn sm" id="tbm-manage">管理绑定</button></div>';
  $$('#tb-menu .acct[data-ai]').forEach(el => el.addEventListener('click', () => {
    state.activeIdx = Number(el.dataset.ai);
    saveAccounts();
    closeTbMenu();
    state.repos = []; state.reposLoaded = false;
    state.stars = []; state.starsLoaded = false;
    state.notifications = []; state.notifLoaded = false;
    state.gists = []; state.gistsLoaded = false;
    state.user = null;
    toast('已切换到 ' + PLATFORMS[activeAccount().platform].label);
    enterShell();
  }));
  const mg = $('#tbm-manage');
  if (mg) mg.addEventListener('click', () => { closeTbMenu(); showView('settings'); });
}
function closeTbMenu(){ $('#tb-menu').classList.remove('open'); }
// 预拉收藏集合：让仓库/搜索视图登录后就能正确回显"已收藏"，无需先打开收藏页
async function preloadStarredSet(){
  const acct = activeAccount();
  if (!acct || (acct.platform !== 'github' && acct.platform !== 'gitlab')) return;
  const gen = state.reqGen;
  try {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await api('GET', '/user/starred?per_page=100&page=' + page);
      if (gen !== state.reqGen) return; // 已切账号/登出，丢弃
      out.push(...batch);
      if (batch.length < 100) break;
    }
    if (state.starsLoaded || gen !== state.reqGen) return; // stars 视图已加载过则不覆盖
    state.starredSet = new Set(out.map(r => r.full_name));
    if (currentView === 'repos' || currentView === 'search') { /* 已渲染的卡片在下一次渲染时更新 */ }
  } catch (e) { /* 静默：回显失败不影响主流程 */ }
}
function enterShell(preloadedUser){
  resetSession(); // 登录/切账号：一次性清理全部会话状态（含 starredSet/selected/apiCache）
  // 登录路径已在 tryLogin 里拿到用户对象，直接复用；其余入口（顶栏/设置切号、启动恢复）走下面的一次拉取
  if (preloadedUser) state.user = preloadedUser;
  $('#view-login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#logout-btn').innerHTML = icon('logout') + '<span>退出登录</span>';
  applyTheme();
  renderTopbar();
  renderNav();
  if (!state.reposLoaded) loadRepos(); // 先启动 loadRepos（它 ++reqGen），后续预拉捕获新代际，互不作废
  refreshNotifCount();
  preloadStarredSet();
  showView('overview');
  if (!state.user && activeAccount()) {
    const gen = state.reqGen; // 代际守卫：切号/登出后晚到的 /user 响应不写回，避免顶栏显示上一个账号
    api('GET', '/user').then(u => {
      if (gen !== state.reqGen) return;
      state.user = u;
      renderOverview();
      renderTopbar();
    }).catch(() => {});
  }
}

/* ---------------- 仓库列表 ---------------- */
async function loadRepos(){
  const gen = ++state.reqGen;
  try {
    const out = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await api('GET', '/user/repos?per_page=100&page=' + page + '&type=owner&sort=pushed');
      if (gen !== state.reqGen) return;
      out.push(...batch);
      if (batch.length < 100) break;
    }
    if (gen !== state.reqGen) return;
    out.sort((a, b) => (b.pushed_at || '').localeCompare(a.pushed_at || ''));
    state.repos = out;
    state.reposLoaded = true;
    if (currentView === 'overview') renderOverview();
    if (currentView === 'repos') renderRepos();
  } catch (e) {
    if (gen !== state.reqGen) return;
    if (currentView === 'overview' || currentView === 'repos')
      $('#view-' + currentView).innerHTML =
        '<div class="card" style="border-color:var(--danger)"><b>仓库列表加载失败</b><br><span style="color:var(--muted)">' +
        esc(e.message) + '</span><br><button class="btn" style="margin-top:12px" data-act="loadRepos">重试</button></div>';
  }
}

const FILTERS = [['all','全部'],['public','公开'],['private','私有'],['source','原创'],['fork','Fork'],['archived','已归档']];
function filteredRepos(){
  let list = state.repos;
  const f = state.filter;
  if (f === 'public') list = list.filter(r => !r.private);
  if (f === 'private') list = list.filter(r => r.private);
  if (f === 'fork') list = list.filter(r => r.fork);
  if (f === 'source') list = list.filter(r => !r.fork);
  if (f === 'archived') list = list.filter(r => r.archived);
  const q = state.query.trim().toLowerCase();
  if (q) list = list.filter(r => r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
  return list;
}

function repoCard(r, mode){
  mode = mode || 'repos';
  const warn = r.private ? '<span class="badge pri">私有</span>' : '<span class="badge pub">公开</span>';
  const fork = r.fork ? '<span class="badge fork">Fork</span>' : '';
  const arch = r.archived ? '<span class="badge closed">已归档</span>' : '';
  let checkbox = '';
  if (mode === 'repos')
    checkbox = '<input type="checkbox" data-check="' + esc(r.id) + '" ' + (state.selected.has(r.id) ? 'checked' : '') + ' title="选中用于批量删除">';
  let firstBtn = '';
  const starred = state.starredSet && state.starredSet.has(r.full_name);
  if (mode === 'stars')
    firstBtn = '<button class="btn sm danger-ghost" data-unstar="' + esc(r.full_name) + '">' + icon('starFill') + ' 取消收藏</button>';
  else if (mode === 'search' || mode === 'repos')
    firstBtn = starred
      ? '<button class="btn sm danger-ghost" data-unstar="' + esc(r.full_name) + '">' + icon('starFill') + ' 已收藏</button>'
      : '<button class="btn sm" data-star="' + esc(r.full_name) + '">' + icon('star') + ' 收藏</button>';
  return `
  <div class="repo-card">
    <div class="top">
      ${checkbox}
      <div class="repo-name" title="${esc(r.full_name)}">${esc(r.name)}</div>
      ${warn}${fork}${arch}
    </div>
    <div class="repo-desc">${esc(r.description || '（无描述）')}</div>
    <div class="repo-meta">
      ${r.language ? '<span><span class="dot" style="background:' + langColor(r.language) + '"></span>' + esc(r.language) + '</span>' : ''}
      <span>${icon('star', 13)} ${r.stargazers_count ?? 0}</span>
      <span>${fmtSize(r.size)}</span>
      <span>${timeAgo(r.pushed_at || r.updated_at)}</span>
    </div>
    <div class="repo-acts">
      ${firstBtn}
      <button class="btn sm tint" data-open="${esc(r.full_name)}">${icon('eye')} 打开</button>
      <a class="btn sm" href="${esc(r.html_url)}" target="_blank">${icon('ext')} 网页</a>
    </div>
  </div>`;
}

function skeletonGrid(){
  return '<div class="repo-grid">' +
    '<div class="skel skel-card"></div><div class="skel skel-card"></div><div class="skel skel-card"></div>' +
    '<div class="skel skel-card"></div><div class="skel skel-card"></div><div class="skel skel-card"></div></div>';
}

function renderRepos(){
  const warn = requireScopes();
  const list = filteredRepos();
  // 重建前记录搜索框焦点与光标（change 触发的重渲染不再丢焦点）
  const prevSearch = (document.activeElement && document.activeElement.id === 'repo-search') ? document.activeElement : null;
  const prevCaret = prevSearch ? prevSearch.selectionStart : null;
  $('#view-repos').innerHTML = `
    ${warn ? '<div class="warn-banner">' + icon('issue') + '<div>' + esc(warn) + '</div></div>' : ''}
    <div class="page-head">
      <div class="page-title">${icon('repo')} 我的仓库 <span class="cnt">${state.repos.length} 个</span></div>
      <div class="page-actions">
        <button class="btn primary" data-act="openCreateRepo">${icon('plus')} 新建仓库</button>
        <button class="btn" data-act="loadRepos">${icon('refresh')} 刷新</button>
      </div>
    </div>
    ${state.selected.size ? `
    <div class="batch-bar">
      ${icon('trash')} 已选中 <b>${state.selected.size}</b> 个仓库
      <button class="btn sm" data-act="selectAllVisible">全选当前结果</button>
      <button class="btn sm" data-act="clearSelection">取消选择</button>
      <button class="btn sm danger" data-act="batchDelete">${icon('trash')} 删除所选</button>
    </div>` : ''}
    <div class="toolbar">
      <div class="chips">
        ${FILTERS.map(([k, l]) => '<button class="chip ' + (state.filter === k ? 'active' : '') + '" data-filter="' + k + '">' + l + '</button>').join('')}
      </div>
      <input class="search" placeholder="搜索仓库名 / 描述…" value="${esc(state.query)}" id="repo-search">
    </div>
    ${!state.reposLoaded
      ? skeletonGrid()
      : (list.length
        ? '<div class="repo-grid">' + list.map(r => repoCard(r, 'repos')).join('') + '</div>'
        : '<div class="card empty">' + icon('repo', 40) + '<div class="big">没有符合条件的仓库</div><div>换个筛选条件，或点右上角新建</div></div>')}
  `;
  $$('#view-repos [data-filter]').forEach(c => c.addEventListener('click', () => {
    state.filter = c.dataset.filter;
    state.selected.clear(); // 切换筛选清空选中：否则批量删除会取到「当前不可见」的仓库（跨筛选残留）
    renderRepos();
  }));
  $$('#view-repos [data-star]').forEach(b => b.addEventListener('click', async () => { if (await doStar(b.dataset.star, true, b)) renderRepos(); }));
  $$('#view-repos [data-unstar]').forEach(b => b.addEventListener('click', async () => { if (await doStar(b.dataset.unstar, false, b)) renderRepos(); }));
  const search = $('#repo-search');
  search.addEventListener('input', () => { state.query = search.value; });
  search.addEventListener('change', () => { state.selected.clear(); renderRepos(); }); // 改搜索词同样清空选中（避免跨筛选残留）
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); state.selected.clear(); renderRepos(); } });
  if (prevSearch && search) {
    search.focus();
    if (prevCaret != null) { try { search.setSelectionRange(prevCaret, prevCaret); } catch (e) {} }
  }
  $$('#view-repos [data-check]').forEach(cb => cb.addEventListener('change', () => {
    const id = Number(cb.dataset.check);
    if (cb.checked) state.selected.add(id); else state.selected.delete(id);
    renderRepos();
  }));
  $$('#view-repos [data-open]').forEach(b => b.addEventListener('click', () => openRepo(b.dataset.open)));
}
function selectAllVisible(){ filteredRepos().forEach(r => state.selected.add(r.id)); renderRepos(); }
function clearSelection(){ state.selected.clear(); renderRepos(); }

// 收藏/取消收藏统一入口：同步维护 starredSet，供各视图回显
async function doStar(full, star, btn) {
  const gen = state.reqGen; // R3-DEF3：starredSet 是跨账号共享的全局对象，在途切号后写回必须丢弃
  if (btn) btn.disabled = true;
  try {
    await api(star ? 'PUT' : 'DELETE', '/user/starred/' + full);
    if (gen !== state.reqGen) return false; // 已切号/登出：服务器侧作用于原账号本就正确，本地副作用全部丢弃（不污染新账号 starredSet、不误弹 toast）
    if (star) state.starredSet.add(full); else state.starredSet.delete(full);
    toast(star ? '已收藏 ' + full : '已取消收藏 ' + full);
    return true;
  } catch (e) {
    if (gen === state.reqGen) toast('操作失败：' + e.message, 'err');
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}
function deleteModal(repos, onDone){
  // 防御：state.user 可能尚未加载完成（null），多仓库确认短语回退到第一个仓库名
  const need = repos.length === 1 ? repos[0].full_name : ((state.user && state.user.login) || repos[0].full_name);
  confirmModal({
    title: '永久删除 ' + repos.length + ' 个仓库',
    bodyHtml: '以下仓库将被<b>永久删除</b>：代码、Issue、PR、Release、Wiki 全部消失，此操作不可恢复。',
    list: repos.map(r => r.full_name),
    required: need,
    okText: '确认删除',
    onConfirm: async () => {
      const raw = await runLimited(repos, 4, async (r) => {
        await api('DELETE', '/repos/' + r.full_name, undefined, { fullName: r.full_name });
      });
      const results = raw.map((x, i) => x.ok
        ? { ok: true, t: repos[i].full_name }
        : { ok: false, t: repos[i].full_name + ' — ' + x.error.message });
      const okN = results.filter(x => x.ok).length;
      openModal(
        '<div class="m-title">删除结果（' + okN + ' / ' + repos.length + ' 成功）</div>' +
        '<div class="m-progress">' + results.map(x =>
          '<div class="' + (x.ok ? 'okl' : 'faill') + '">' + (x.ok ? '✓ ' : '✗ ') + esc(x.t) + '</div>').join('') +
        '</div><div class="m-actions"><button class="btn primary" data-act="closeModal">好的</button></div>');
      toast('已删除 ' + okN + ' / ' + repos.length + ' 个仓库');
      if (onDone) onDone();
    },
  });
}
function batchDelete(){
  const targets = state.repos.filter(r => state.selected.has(r.id));
  if (!targets.length) return;
  deleteModal(targets, () => { clearSelection(); state.reposLoaded = false; loadRepos(); });
}

function openCreateRepo(){
  openModal(`
    <div class="m-title">新建仓库</div>
    <div class="m-field"><label class="field-label">仓库名称（字母、数字、- _ .）</label>
      <input class="m-input" id="cr-name" autocomplete="off"></div>
    <div class="m-field"><label class="field-label">描述（可选）</label>
      <input class="m-input" id="cr-desc" autocomplete="off"></div>
    <div class="m-field"><label class="field-label">可见性</label>
      <div class="radio-row">
        <label><input type="radio" name="cr-vis" value="private" checked> 私有</label>
        <label><input type="radio" name="cr-vis" value="public"> 公开</label>
      </div></div>
    <label class="m-check"><input type="checkbox" id="cr-init" checked> 自动创建 README</label>
    <div class="m-actions">
      <button class="btn" id="cr-cancel">取消</button>
      <button class="btn primary" id="cr-ok">${icon('plus')} 创建</button>
    </div>
  `);
  $('#cr-cancel').addEventListener('click', closeModal);
  $('#cr-name').focus();
  $('#cr-ok').addEventListener('click', async () => {
    const __ok = $('#cr-ok'); if (__ok.disabled) return;
    const name = $('#cr-name').value.trim();
    const desc = $('#cr-desc').value.trim();
    const priv = document.querySelector('[name=cr-vis]:checked').value === 'private';
    const init = $('#cr-init').checked;
    if (!name) { toast('请填写仓库名称', 'err'); return; }
    if (!/^[A-Za-z0-9._-]+$/.test(name)) { toast('名称只能包含字母、数字和 - _ .', 'err'); return; }
    __ok.disabled = true;
    try {
      await api('POST', '/user/repos', { name, description: desc, private: priv, auto_init: init });
      toast('仓库 ' + name + ' 创建成功');
      closeModal();
      state.reposLoaded = false;
      loadRepos();
    } catch (e) { __ok.disabled = false; toast('创建失败：' + e.message, 'err'); }
  });
}

/* ---------------- 总览 ---------------- */
function renderOverview(){
  const u = state.user;
  if (!u) return;
  const warn = requireScopes();
  const hour = new Date().getHours();
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const recent = state.repos.slice(0, 6);
  // 仓库统计：远程（/user 字段）与本地（仓库列表）双源都统计，取更大值，悬停可看明细
  const ownRepos = state.repos.filter(r => !r.fork);
  const pubRemote = u.public_repos ?? null;
  const pubLocal = state.reposLoaded ? ownRepos.filter(r => !r.private).length : null;
  const priRemote = u.total_private_repos ?? null;
  const priLocal = state.reposLoaded ? ownRepos.filter(r => r.private).length : null;
  const statMax = (a, b) => (a == null && b == null) ? 0 : Math.max(a ?? 0, b ?? 0);
  const pubCount = statMax(pubRemote, pubLocal);
  const priCount = statMax(priRemote, priLocal);
  const statTip = (r, l) => 'title="远程统计 ' + (r ?? '-') + ' · 本地统计 ' + (l ?? '-') + '"';
  const pubTip = statTip(pubRemote, pubLocal);
  const priTip = statTip(priRemote, priLocal);
  $('#view-overview').innerHTML = `
    ${warn ? '<div class="warn-banner">' + icon('issue') + '<div>' + esc(warn) + '</div></div>' : ''}
    <div class="card hero">
      <div class="user-row">
        <img class="avatar" src="${esc(u.avatar_url)}" alt="">
        <div>
          <div class="user-name">${greet}，${esc(u.name || u.login)}</div>
          <div class="user-login">@${esc(u.login)}</div>
          ${u.bio ? '<div class="user-bio">' + esc(u.bio) + '</div>' : ''}
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat" ${pubTip}><div class="num">${pubCount}</div><div class="lbl">公开仓库</div></div>
        <div class="stat" ${priTip}><div class="num">${priCount}</div><div class="lbl">私有仓库</div></div>
        <div class="stat"><div class="num">${u.followers ?? 0}</div><div class="lbl">关注者</div></div>
        <div class="stat"><div class="num">${u.following ?? 0}</div><div class="lbl">正在关注</div></div>
      </div>
    </div>
    <div class="page-head" style="margin-top:24px"><div class="page-title">快捷操作</div></div>
    <div class="page-actions">
      <button class="btn primary" data-act="openCreateRepo">${icon('plus')} 新建仓库</button>
      <button class="btn" data-act="showView" data-arg="repos">${icon('trash')} 批量清理仓库</button>
      <button class="btn" data-act="showView" data-arg="notifications">${icon('bell')} 查看通知</button>
      <button class="btn" data-act="showView" data-arg="search">${icon('search')} 全局搜索</button>
      <button class="btn" data-act="loadRepos">${icon('refresh')} 刷新数据</button>
    </div>
    <div class="page-head" style="margin-top:24px"><div class="page-title">最近更新的仓库</div></div>
    ${state.reposLoaded
      ? (recent.length
        ? '<div class="repo-grid">' + recent.map(r => repoCard(r, 'plain')).join('') + '</div>'
        : '<div class="card empty">' + icon('repo', 40) + '<div class="big">还没有任何仓库</div><div>点上面「新建仓库」创建第一个</div></div>')
      : skeletonGrid()}
  `;
  $$('#view-overview [data-open]').forEach(b => b.addEventListener('click', () => openRepo(b.dataset.open)));
}


/* ---------------- 收藏 Stars ---------------- */
async function loadStars(){
  const gen = ++state.reqGen;
  renderStarsLoading();
  try {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await api('GET', '/user/starred?per_page=100&page=' + page);
      if (gen !== state.reqGen) return;
      out.push(...batch);
      if (batch.length < 100) break;
    }
    if (gen !== state.reqGen) return;
    out.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
    state.stars = out;
    state.starsLoaded = true;
    state.starredSet = new Set(out.map(r => r.full_name)); // 收藏状态回显数据源
    renderStars();
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4：旧请求失败不得覆盖当前视图
    $('#view-stars').innerHTML = '<div class="card" style="border-color:var(--danger)"><b>收藏加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}
function renderStarsLoading(){
  $('#view-stars').innerHTML = `
    <div class="page-head"><div class="page-title">${icon('star')} 我的收藏</div></div>
    ${skeletonGrid()}`;
}
function renderStars(){
  const list = state.stars;
  $('#view-stars').innerHTML = `
    <div class="page-head">
      <div class="page-title">${icon('star')} 我的收藏 <span class="cnt">${list.length} 个</span></div>
      <div class="page-actions"><button class="btn" data-act="loadStars">${icon('refresh')} 刷新</button></div>
    </div>
    ${list.length
      ? '<div class="repo-grid">' + list.map(r => repoCard(r, 'stars')).join('') + '</div>'
      : '<div class="card empty">' + icon('star', 40) + '<div class="big">还没有收藏任何仓库</div><div>在 GitHub 网页上点 Star 后会出现在这里</div></div>'}
  `;
  $$('#view-stars [data-open]').forEach(b => b.addEventListener('click', () => openRepo(b.dataset.open)));
  $$('#view-stars [data-unstar]').forEach(b => b.addEventListener('click', async () => {
    if (await doStar(b.dataset.unstar, false, b)) {
      state.stars = state.stars.filter(r => r.full_name !== b.dataset.unstar);
      renderStars();
    }
  }));
}

/* ---------------- 通知 ---------------- */
const NOTIF_ICONS = { Issue:'issue', PullRequest:'pr', Release:'tag', CheckSuite:'zap', Discussion:'comment', Commit:'commit' };
async function loadNotifications(){
  const gen = ++state.reqGen;
  renderNotificationsLoading();
  try {
    const list = await api('GET', '/notifications?per_page=50' + (state.notifAll ? '&all=true' : ''));
    if (gen !== state.reqGen) return;
    state.notifications = list;
    state.notifLoaded = true;
    state.notifCount = list.filter(x => x.unread).length;
    renderNav();
    renderNotifications();
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4
    $('#view-notifications').innerHTML = '<div class="card" style="border-color:var(--danger)"><b>通知加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}
function renderNotificationsLoading(){
  $('#view-notifications').innerHTML = `
    <div class="page-head"><div class="page-title">${icon('bell')} 通知</div></div>
    <div class="row-list">${'<div class="skel" style="height:52px;border-radius:0"></div>'.repeat(5)}</div>`;
}
function renderNotifications(){
  const list = state.notifications;
  $('#view-notifications').innerHTML = `
    <div class="page-head">
      <div class="page-title">${icon('bell')} 通知 <span class="cnt">${list.length} 条</span></div>
      <div class="page-actions">
        <button class="btn" data-act="markAllRead">${icon('check')} 全部标记已读</button>
        <button class="btn" data-act="loadNotifications">${icon('refresh')} 刷新</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="chips">
        <button class="chip ${!state.notifAll ? 'active' : ''}" data-nf="unread">未读</button>
        <button class="chip ${state.notifAll ? 'active' : ''}" data-nf="all">全部</button>
      </div>
    </div>
    ${list.length
      ? '<div class="row-list">' + list.map(n => {
          const ic = NOTIF_ICONS[n.subject.type] || 'bell';
          return '<div class="row-item">' +
            (n.unread ? '<span class="unread-dot"></span>' : '<span style="width:8px;flex:none"></span>') +
            '<span class="row-icon">' + icon(ic, 18) + '</span>' +
            '<div class="row-main"><div class="row-title ' + (n.unread ? '' : 'plain') + '" style="cursor:default">' + esc(n.subject.title) + '</div>' +
            '<div class="row-sub">' + esc(n.repository.full_name) + ' · ' + esc(n.subject.type) + ' · ' + timeAgo(n.updated_at) + '</div></div>' +
            '<div class="row-side">' +
            (n.unread ? '<button class="btn sm" data-nread="' + n.id + '">标为已读</button>' : '') +
            '<a class="btn sm" href="' + esc(n.subject.url ? n.subject.url.replace('api.github.com/repos', 'github.com') : '') + '" target="_blank">' + icon('ext') + '</a></div></div>';
        }).join('') + '</div>'
      : '<div class="card empty">' + icon('bell', 40) + '<div class="big">没有通知</div><div>世界清静了</div></div>'}
  `;
  $$('#view-notifications [data-nf]').forEach(c => c.addEventListener('click', () => {
    state.notifAll = c.dataset.nf === 'all';
    loadNotifications();
  }));
  $$('#view-notifications [data-nread]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api('PATCH', '/notifications/threads/' + b.dataset.nread);
      loadNotifications();
    } catch (e) { toast('操作失败：' + e.message, 'err'); }
  }));
}
async function markAllRead(){
  try {
    await api('PUT', '/notifications');
    toast('已全部标记为已读');
    loadNotifications();
  } catch (e) { toast('操作失败：' + e.message, 'err'); }
}

/* ---------------- 全局搜索 ---------------- */
function renderSearch(){
  $('#view-search').innerHTML = `
    <div class="page-head"><div class="page-title">${icon('search')} 全局搜索</div></div>
    <div class="card">
      <div class="form-row">
        <div class="m-field">
          <label class="field-label">搜索 GitHub 上的公开仓库</label>
          <input class="m-input" id="gs-input" placeholder="例如：todo app / machine learning / 用户名/仓库名" style="font-family:var(--mono)"
            value="${esc(state.searchQuery)}">
        </div>
        <button class="btn primary" id="gs-btn" style="height:42px">${icon('search')} 搜索</button>
      </div>
      <div style="font-size:12.5px;color:var(--muted)">支持 GitHub 搜索语法，如 <code style="font-family:var(--mono)">stars:>1000 language:python</code></div>
    </div>
    <div id="gs-results" style="margin-top:18px">
      ${state.searchResults === null ? '' : (state.searching ? '<div class="loading"><div class="spinner"></div>搜索中 ...</div>' : renderSearchResults())}
    </div>
  `;
  $('#gs-btn').addEventListener('click', doSearch);
  $('#gs-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  if (state.searchResults !== null && !state.searching) bindSearchResults();
}
function renderSearchResults(){
  const items = state.searchResults || [];
  return items.length
    ? '<div class="page-head"><div class="page-title" style="font-size:16px">结果 <span class="cnt">' + items.length + ' 个</span></div></div>' +
      '<div class="repo-grid">' + items.map(r => repoCard(r, 'search')).join('') + '</div>'
    : '<div class="card empty">' + icon('search', 40) + '<div class="big">没有找到相关仓库</div></div>';
}
function bindSearchResults(){
  $$('#gs-results [data-open]').forEach(b => b.addEventListener('click', () => openRepo(b.dataset.open)));
  $$('#gs-results [data-star]').forEach(b => b.addEventListener('click', async () => {
    // ENG-2：renderSearchResults 只返回字符串，裸调用是 no-op——必须写回 DOM 并重新 bind
    if (await doStar(b.dataset.star, true, b)) { $('#gs-results').innerHTML = renderSearchResults(); bindSearchResults(); }
  }));
  $$('#gs-results [data-unstar]').forEach(b => b.addEventListener('click', async () => {
    if (await doStar(b.dataset.unstar, false, b)) { $('#gs-results').innerHTML = renderSearchResults(); bindSearchResults(); }
  }));
}
async function doSearch(){
  const q = $('#gs-input').value.trim();
  if (!q) { toast('请输入搜索内容', 'err'); return; }
  const gen = state.reqGen; // 代际守卫：切号/登出后晚到的搜索结果不写回（否则搜索页出现上一个账号的结果）
  state.searchQuery = q;
  state.searching = true;
  state.searchResults = [];
  $('#gs-results').innerHTML = '<div class="loading"><div class="spinner"></div>搜索中 ...</div>';
  try {
    const res = await api('GET', '/search/repositories?q=' + encodeURIComponent(q) + '&per_page=24&sort=stars');
    // 守卫拦截时也必须复位 searching：否则 state.searching 永久卡 true → renderSearch 一直显示「搜索中…」（QA-N1）
    if (gen !== state.reqGen) { state.searching = false; return; }
    state.searchResults = res.items || [];
    state.searching = false;
    $('#gs-results').innerHTML = renderSearchResults();
    bindSearchResults();
  } catch (e) {
    if (gen !== state.reqGen) { state.searching = false; return; } // 同上：失败分支被守卫拦下也复位（QA-N1）
    state.searching = false;
    $('#gs-results').innerHTML = '<div class="card" style="border-color:var(--danger)"><b>搜索失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}

/* ---------------- Gists ---------------- */
function gistTitle(g){
  if (g.description) return g.description;
  const files = Object.keys(g.files || {});
  return files.length ? files[0] : '(无标题)';
}
function gistFileCount(g){ return Object.keys(g.files || {}).length; }
async function loadGists(){
  const gen = ++state.reqGen;
  $('#view-gists').innerHTML = `
    <div class="page-head">
      <div class="page-title">${icon('code')} 代码片段 <span class="cnt">${state.gists.length || ''}</span></div>
      <div class="page-actions">
        <button class="btn primary" data-act="openNewGist">${icon('plus')} 新建 Gist</button>
        <button class="btn" data-act="loadGists">${icon('refresh')} 刷新</button>
      </div>
    </div>
    <div class="loading"><div class="spinner"></div>正在加载 ...</div>`;
  try {
    const list = await api('GET', '/gists?per_page=50');
    if (gen !== state.reqGen) return;
    state.gists = list;
    state.gistsLoaded = true;
    $('#view-gists').innerHTML = `
      <div class="page-head">
        <div class="page-title">${icon('code')} 代码片段 <span class="cnt">${list.length} 个</span></div>
        <div class="page-actions">
          <button class="btn primary" data-act="openNewGist">${icon('plus')} 新建 Gist</button>
          <button class="btn" data-act="loadGists">${icon('refresh')} 刷新</button>
        </div>
      </div>
      ${list.length
        ? '<div class="row-list">' + list.map(g => `
          <div class="row-item">
            <span class="row-icon">${icon('code', 18)}</span>
            <div class="row-main">
              <div class="row-title plain" style="cursor:default">${esc(gistTitle(g))}</div>
              <div class="row-sub">${gistFileCount(g)} 个文件 · ${g.public ? '公开' : '秘密'} · ${timeAgo(g.updated_at)}</div>
            </div>
            <div class="row-side">
              <button class="btn sm" data-gview="${esc(g.id)}">${icon('eye')} 查看</button>
              <a class="btn sm" href="${esc(g.html_url)}" target="_blank">${icon('ext')}</a>
              <button class="btn sm danger-ghost" data-gdel="${esc(g.id)}" data-gname="${esc(gistTitle(g))}">${icon('trash')}</button>
            </div>
          </div>`).join('') + '</div>'
        : '<div class="card empty">' + icon('code', 40) + '<div class="big">还没有 Gist</div><div>Gist 适合存放小段代码、配置、笔记</div></div>'}
    `;
    $$('#view-gists [data-gview]').forEach(b => b.addEventListener('click', () => openGist(b.dataset.gview)));
    $$('#view-gists [data-gdel]').forEach(b => b.addEventListener('click', () => {
      confirmModal({
        title: '删除 Gist',
        bodyHtml: '即将永久删除 Gist：<b>' + esc(b.dataset.gname) + '</b>',
        required: 'DELETE',
        okText: '确认删除',
        onConfirm: async () => {
          await api('DELETE', '/gists/' + b.dataset.gdel);
          if (gen !== state.reqGen) return;
          toast('Gist 已删除');
          state.gists = state.gists.filter(g => g.id !== b.dataset.gdel);
          loadGists();
        },
      });
    }));
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4
    $('#view-gists').innerHTML = '<div class="card" style="border-color:var(--danger)"><b>Gist 加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}
async function openGist(id){
  const gen = ++state.reqGen; // ENG-5：写 #modal 的请求必须递增代际（与 openPrFiles 同构），否则连点两个 Gist 时慢响应覆盖后点开的弹窗
  try {
    const g = await api('GET', '/gists/' + id);
    if (gen !== state.reqGen) return; // 旧响应：不覆盖当前弹窗
    const files = Object.values(g.files || {});
    const body = files.map(f =>
      '<div class="file-head" style="margin-top:14px"><span class="file-name">' + esc(f.filename) + '</span>' +
      '<span style="color:var(--muted);font-size:12px">' + esc(f.language || '') + ' · ' + fmtSize(Math.round((f.size || 0) / 1024)) + '</span></div>' +
      '<pre class="code">' + esc(f.content || '（内容过大，请到网页查看）') + '</pre>').join('');
    openModal(`
      <div class="m-title">${esc(gistTitle(g))}</div>
      <p class="m-text">${g.public ? '公开' : '秘密'} · 更新于 ${timeAgo(g.updated_at)}</p>
      <div style="max-height:52vh;overflow-y:auto">${body || '<div class="empty">无文件内容</div>'}</div>
      <div class="m-actions">
        <a class="btn" href="${esc(g.html_url)}" target="_blank">${icon('ext')} 在网页打开</a>
        <button class="btn primary" data-act="closeModal">关闭</button>
      </div>
    `);
  } catch (e) { if (gen === state.reqGen) toast('读取失败：' + e.message, 'err'); }
}
function openNewGist(){
  openModal(`
    <div class="m-title">新建 Gist</div>
    <div class="m-field"><label class="field-label">描述（可选）</label>
      <input class="m-input" id="ng-desc" autocomplete="off"></div>
    <div class="m-field"><label class="field-label">文件名（如 notes.md / main.py）</label>
      <input class="m-input" id="ng-name" style="font-family:var(--mono)" autocomplete="off"></div>
    <div class="m-field"><label class="field-label">内容</label>
      <textarea class="m-textarea" id="ng-content" style="min-height:150px"></textarea></div>
    <label class="m-check"><input type="checkbox" id="ng-public"> 公开（不勾选 = 秘密 Gist）</label>
    <div class="m-actions">
      <button class="btn" id="ng-cancel">取消</button>
      <button class="btn primary" id="ng-ok">${icon('plus')} 创建</button>
    </div>
  `);
  $('#ng-cancel').addEventListener('click', closeModal);
  $('#ng-name').focus();
  $('#ng-ok').addEventListener('click', async () => {
    const __ok = $('#ng-ok'); if (__ok.disabled) return;
    const name = $('#ng-name').value.trim();
    const content = $('#ng-content').value;
    if (!name) { toast('请填写文件名', 'err'); return; }
    __ok.disabled = true;
    try {
      await api('POST', '/gists', {
        description: $('#ng-desc').value.trim(),
        public: $('#ng-public').checked,
        files: { [name]: { content } },
      });
      toast('Gist 创建成功');
      closeModal();
      loadGists();
    } catch (e) { __ok.disabled = false; toast('创建失败：' + e.message, 'err'); }
  });
}

/* ---------------- 全局设置页 ---------------- */
function renderSettings(){
  const accountsRows = state.accounts.map((a, i) => {
    const P = PLATFORMS[a.platform];
    const active = i === state.activeIdx;
    return '<div class="row-item">' +
      '<span class="row-icon">' + icon('repo', 18) + '</span>' +
      '<div class="row-main"><div class="row-title plain" style="cursor:default">' + esc(P.label) + '</div>' +
      '<div class="row-sub">' + esc((a.label || '').split('·').pop().trim()) + '</div></div>' +
      '<div class="row-side">' +
      (active ? '<span class="badge def">当前</span>' : '<button class="btn sm" data-act="' + i + '">切换</button>') +
      '<button class="btn sm danger-ghost" data-del="' + i + '" title="解绑">' + icon('trash') + '</button></div></div>';
  }).join('');
  $('#view-settings').innerHTML = `
    <div class="page-head"><div class="page-title">${icon('gear')} 设置</div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="m-title">平台绑定</div>
      <p class="m-text">支持 GitHub / GitLab / Gitee / GitCode 多账号绑定。点顶栏的平台标签可快速切换；新增账号点下面按钮，回到登录页选择平台并粘贴 Token。</p>
      ${state.accounts.length
        ? '<div class="row-list" style="margin-bottom:14px">' + accountsRows + '</div>'
        : '<div class="empty">' + icon('repo', 36) + '<div class="big">还没有绑定账号</div></div>'}
      <div class="page-actions">
        <button class="btn primary" id="st-add">${icon('plus')} 添加新平台账号</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="m-title">网络代理</div>
      <p class="m-text">GitHub 直连超时/被墙时，可走本机代理客户端（肥猫云、Clash、V2Ray 等）的本地端口。改动即时生效，重启保持。</p>
      <div class="chips" id="proxy-chips">
        <button class="chip" data-pv="system">跟随系统</button>
        <button class="chip" data-pv="direct">直连</button>
        <button class="chip" data-pv="custom">自定义代理</button>
      </div>
      <div class="form-row" style="margin-top:12px">
        <div class="m-field" style="flex:1;min-width:240px">
          <label class="field-label">代理地址</label>
          <input class="m-input" id="proxy-input" placeholder="例如 127.0.0.1:7890 或 socks5://127.0.0.1:1080" style="font-family:var(--mono)">
        </div>
        <button class="btn" id="proxy-save">保存</button>
        <button class="btn" id="proxy-test">测试 GitHub 连接</button>
      </div>
      <div id="proxy-status" style="font-size:12.5px;color:var(--muted)"></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="m-title">关闭行为</div>
      <p class="m-text">点窗口 × 时的默认动作。选了「不再询问」的策略后，随时可以在这里改回来。</p>
      <div class="chips" id="close-policy-chips">
        <button class="chip" data-cp="ask">每次询问</button>
        <button class="chip" data-cp="minimize">最小化到后台</button>
        <button class="chip" data-cp="exit">直接退出</button>
      </div>
      <div id="cp-current" style="margin-top:10px;color:var(--muted);font-size:12.5px"></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="m-title">外观</div>
      <div class="page-actions">
        <button class="btn" data-act="toggleTheme">${icon(state.theme === 'dark' ? 'sun' : 'moon')} 切换到${state.theme === 'dark' ? '浅色' : '深色'}模式</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="m-title">拖拽上传</div>
      <p class="m-text">拖入文件数超过 ${DROP_SUGGEST} 个时会弹确认框，避免逐文件上传触发平台限流。若你曾勾选「记住我的选择」，可在此恢复为每次都询问。</p>
      <div id="up-pref-current" style="color:var(--muted);font-size:12.5px;margin-bottom:10px"></div>
      <div class="page-actions">
        <button class="btn" id="up-pref-reset">恢复默认（每次都询问）</button>
      </div>
    </div>
    <div class="card">
      <div class="m-title">关于</div>
      <p class="m-text" style="margin-bottom:6px">
        Git 控制台 · 本地多平台 Git 管理台（GitHub / GitLab / Gitee / GitCode）<br>
        界面直接调用各平台官方 API，无任何中间服务器<br>
        当前登录：<b>@${esc(state.user ? (state.user.login || '') : '')}</b> · ${esc(activeAccount() ? PLATFORMS[activeAccount().platform].label : '')}
      </p>
      <div id="bi-exe" style="font-size:11.5px;color:var(--subtle);font-family:var(--mono);word-break:break-all"></div>
    </div>
  `;
  $$('#view-settings [data-act]').forEach(b => b.addEventListener('click', () => {
    // 切账号统一走 enterShell：内部 resetSession 全量清理（含 starredSet/selected/reqGen/apiCache），
    // 与顶栏切号路径等价——此前手抄清单漏了 selected（批量删除误删风险）与 gists/starredSet（跨账号泄漏）
    state.activeIdx = Number(b.dataset.act);
    saveAccounts();
    enterShell();
    toast('已切换账号');
  }));
  $$('#view-settings [data-del]').forEach(b => b.addEventListener('click', () => {
    const i = Number(b.dataset.del);
    const a = state.accounts[i];
    confirmModal({
      title: '解绑账号',
      bodyHtml: '解除 ' + esc(PLATFORMS[a.platform].label) + ' 账号 <b>' + esc((a.label || '').split('·').pop().trim()) + '</b> 的绑定？Token 将从本机删除。',
      required: 'UNBIND',
      okText: '确认解绑',
      onConfirm: () => {
        const wasActive = i === state.activeIdx;
        removeAccount(i);
        // 解绑最后一个账号 → 直接回登录页：否则 renderRepos 在无账号时永远渲染骨架屏（reposLoaded 恒 false），点「我的仓库」永久转圈
        if (!state.accounts.length) { logout('已解绑全部账号'); return; }
        // 解绑的是当前活跃账号 → activeIdx 已切到继任者，必须走 enterShell 全量重置会话，
        // 否则 repos/repo/notifications 等仍是上一个账号数据，切视图会出现跨账号串号
        if (wasActive) { enterShell(); toast('已解绑并切换账号'); return; }
        state.user = null;
        renderSettings();
        renderTopbar();
        toast('已解绑');
      },
    });
  }));
  $('#st-add').addEventListener('click', () => logout('选择平台并粘贴 Token 以添加新账号'));
  const cpNames = { ask: '每次询问', minimize: '点 × 直接最小化到后台', exit: '点 × 直接退出' };
  const applyCp = (p) => {
    $$('#close-policy-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.cp === p));
    $('#cp-current').textContent = '当前策略：' + (cpNames[p] || p);
  };
  fetch(bridgeURL('getpolicy')).then(r => r.json()).then(d => applyCp(d.policy)).catch(() => {});
  $$('#close-policy-chips .chip').forEach(c => c.addEventListener('click', () => {
    fetch(bridgeURL('setpolicy', '&value=' + c.dataset.cp))
      .then(() => { applyCp(c.dataset.cp); toast('关闭行为已更新'); })
      .catch(() => {});
  }));
  // 网络代理（仅桌面版有效；Edge app 模式自动跟随系统代理）
  const cpProxyNames = { system: '跟随系统', direct: '直连' };
  const applyProxyUI = (v) => {
    v = v || 'system';
    const custom = v !== 'system' && v !== 'direct';
    $$('#proxy-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.pv === (custom ? 'custom' : v)));
    $('#proxy-input').value = custom ? v : '';
    $('#proxy-status').textContent = '当前代理：' + (custom ? v : (cpProxyNames[v] || v));
  };
  fetch(bridgeURL('getproxy')).then(r => r.json()).then(d => applyProxyUI(d.proxy)).catch(() => {});
  $$('#proxy-chips .chip').forEach(c => c.addEventListener('click', () => {
    const v = c.dataset.pv;
    if (v === 'custom') { applyProxyUI($('#proxy-input').value.trim() || 'custom'); $('#proxy-input').focus(); return; }
    fetch(bridgeURL('setproxy', '&value=' + encodeURIComponent(v)))
      .then(r => r.json())
      .then(d => {
        // 按主进程真实结果给反馈：应用失败时不再无条件说「已更新」
        if (!d || !d.ok) { toast('代理更新失败：' + ((d && d.error) || '未知错误'), 'err'); return; }
        applyProxyUI(v); toast('代理已更新');
      })
      .catch(() => toast('代理更新失败：无法连接本地服务', 'err'));
  }));
  $('#proxy-save').addEventListener('click', () => {
    const v = $('#proxy-input').value.trim();
    if (!v) { toast('请填写代理地址（如 127.0.0.1:7890）', 'err'); return; }
    fetch(bridgeURL('setproxy', '&value=' + encodeURIComponent(v)))
      .then(r => r.json())
      .then(d => {
        // 仅在主进程确认 setProxy 成功后，才回显「已生效」
        if (!d || !d.ok) { toast('代理保存失败：' + ((d && d.error) || '未知错误'), 'err'); return; }
        applyProxyUI(v); toast('代理已保存并生效');
      })
      .catch(() => toast('代理保存失败：无法连接本地服务', 'err'));
  });
  fetch(bridgeURL('buildinfo')).then(r => r.json()).then(d => {
    const el = $('#bi-exe');
    if (el) el.textContent = '运行程序：' + d.exe + '（构建于 ' + (d.mtime || '?').replace('T', ' ').slice(0, 16) + '）';
  }).catch(() => {});
  // 拖拽上传：展示/恢复「记住我的选择」。没有这个入口，用户一旦记住就永远无法反悔
  const upPrefEl = $('#up-pref-current');
  if (upPrefEl) upPrefEl.textContent = '当前：' + uploadPrefLabel(loadUploadPref());
  const upPrefReset = $('#up-pref-reset');
  if (upPrefReset) upPrefReset.addEventListener('click', () => {
    clearUploadPref();
    if (upPrefEl) upPrefEl.textContent = '当前：' + uploadPrefLabel(loadUploadPref());
    toast('已恢复：拖入超量文件时每次都会询问');
  });
  $('#proxy-test').addEventListener('click', () => {
    const st = $('#proxy-status');
    st.textContent = '正在测试 GitHub 连接（最多 8 秒）...';
    fetch(bridgeURL('ping')).then(r => r.json()).then(d => {
      st.textContent = d.ok
        ? '✓ GitHub 连接正常（' + d.ms + 'ms）'
        : '✗ 连接失败：' + (d.error || ('HTTP ' + d.status)) + ' —— 如果代理客户端已开启，请确认端口后重新保存';
    }).catch(() => { st.textContent = '✗ 测试请求失败'; });
  });
}


/* ---------------- 仓库详情 ---------------- */
const REPO_TABS = [
  ['files', '文件', 'folder'],
  ['commits', 'Commits', 'commit'],
  ['branches', '分支', 'branch'],
  ['issues', 'Issues', 'issue'],
  ['pulls', 'PR', 'pr'],
  ['releases', 'Releases', 'tag'],
  ['actions', 'Actions', 'zap'],
  ['settings', '设置', 'gear'],
];

async function openRepo(fullName){
  const gen = ++state.reqGen; // ENG-6：递增代际，同时作废其他 openRepo 与在途列表加载——否则快速连点两仓库时先点开的慢响应会覆盖详情页（危险操作作用于错误仓库）
  try {
    showView('repo');
    $('#view-repo').innerHTML = '<div class="loading"><div class="spinner"></div>正在打开仓库 ...</div>';
    // opts.fullName：openRepo 的仓库由入参 fullName 指定（此刻 state.repo 可能还是上一个仓库），故显式传入
    const repo = await api('GET', '/repos/' + fullName, undefined, { fullName });
    if (gen !== state.reqGen) return;
    let branches;
    try { branches = await api('GET', '/repos/' + fullName + '/branches?per_page=100', undefined, { fullName }); }
    catch (e) { branches = []; }
    if (gen !== state.reqGen) return; // 两次 await 之后统一写回，避免旧响应污染 state
    state.repo = repo;
    state.branches = branches;
    state.branch = repo.default_branch;
    state.path = '';
    state.file = null;
    state.tab = 'files';
    renderRepoDetail();
    loadContents();
    refreshNotifCount();
  } catch (e) {
    if (gen !== state.reqGen) return;
    $('#view-repo').innerHTML =
      '<div class="card" style="border-color:var(--danger)"><b>打开仓库失败</b><br><span style="color:var(--muted)">' +
      esc(e.message) + '</span><br><button class="btn" style="margin-top:12px" data-act="showViewBack">返回</button></div>';
  }
}
function currentViewBack(){ return state.reposLoaded ? 'repos' : 'overview'; }

function isStarred(){ return state.repo && (state.starredSet.has(state.repo.full_name) || state.repo.viewer_has_starred); }

function renderRepoDetail(){
  const r = state.repo;
  const caps = activePlatform() ? activePlatform().caps : {};
  const r0 = state.repo || {};
  const canAdmin = !!(r0.permissions && r0.permissions.admin === true) || !!r0.permissions_admin || r0.permission === 'admin' ||
    !!(r0.owner && state.user && r0.owner.login === state.user.login);
  const visTabs = REPO_TABS.filter(([k]) => (k === 'actions' ? !!caps.actions : k === 'releases' ? !!caps.releases : k === 'settings' ? !!canAdmin : true));
  if (!visTabs.some(([k]) => k === state.tab)) state.tab = 'files';
  const tabs = visTabs
    .map(([k, l, ic]) =>
      '<button class="tab ' + (state.tab === k ? 'active' : '') + '" data-tab="' + k + '">' + icon(ic) + ' ' + l + '</button>').join('');
  $('#view-repo').innerHTML = `
    <div class="page-head">
      <button class="btn" data-act="showView" data-arg="repos">${icon('back')} 返回列表</button>
      <div class="page-actions">
        <button class="btn" id="rd-star">${icon(isStarred() ? 'starFill' : 'star')} ${isStarred() ? '取消收藏' : '收藏'}</button>
        <button class="btn" id="rd-fork">${icon('fork')} Fork</button>
        <a class="btn" href="${esc(r.html_url)}" target="_blank">${icon('ext')} 在网页打开</a>
        <button class="btn danger" id="rd-del">${icon('trash')} 删除</button>
      </div>
    </div>
    <div class="card hero">
      <div class="repo-head-top">
        <div class="repo-head-main">
          <div class="repo-title">${esc(r.name)}
            ${r.private ? '<span class="badge pri">私有</span>' : '<span class="badge pub">公开</span>'}
            ${r.fork ? '<span class="badge fork">Fork</span>' : ''}
            ${r.archived ? '<span class="badge closed">已归档</span>' : ''}
          </div>
          <div class="user-bio">${esc(r.description || '（无描述）')}</div>
          <div class="meta-line">
            <span class="meta-item">${icon('star')} <b>${r.stargazers_count ?? 0}</b></span>
            <span class="meta-item">${icon('fork')} <b>${r.forks_count ?? 0}</b></span>
            <span class="meta-item">${icon('issue')} <b>${r.open_issues_count ?? 0}</b></span>
            ${r.watchers_count != null ? '<span class="meta-item">' + icon('eye') + ' <b>' + r.watchers_count + '</b></span>' : ''}
            ${r.language ? '<span class="meta-item"><span class="dot" style="background:' + langColor(r.language) + '"></span>' + esc(r.language) + '</span>' : ''}
            <span class="meta-item">${fmtSize(r.size)}</span>
            <span class="meta-item">默认分支 <b>${esc(r.default_branch)}</b></span>
          </div>
        </div>
      </div>
      <div class="tabs">${tabs}</div>
      <div id="repo-body"></div>
    </div>
  `;
  $$('#view-repo [data-tab]').forEach(t => t.addEventListener('click', () => {
    state.tab = t.dataset.tab;
    state.file = null;
    renderRepoDetail();
    ({ files: loadContents, commits: loadCommits, branches: loadBranches,
       issues: loadIssues, pulls: loadPulls, releases: loadReleases,
       actions: loadRuns, settings: renderRepoSettings }[state.tab] || (() => {}))();
  }));
  $('#rd-star').addEventListener('click', starToggle);
  $('#rd-fork').addEventListener('click', forkRepo);
  $('#rd-del').addEventListener('click', () => deleteModal([state.repo], () => {
    state.reposLoaded = false;
    loadRepos();
    showView('repos');
  }));
}

async function starToggle(){
  const repo = state.repo; // 捕获调用时的仓库引用：await 后不得再读实时 state.repo（否则在途切仓库会污染新仓库）
  const full = repo && repo.full_name;
  if (!repo || !full) return;
  const gen = state.reqGen; // R3-DEF3：starredSet 是跨账号共享的全局对象，在途切号后写回必须丢弃（第二轮只修了 state.repo 捕获，遗漏此处）
  try {
    const starred = state.starredSet.has(full) || repo.viewer_has_starred; // 以 starredSet 为准
    if (starred) {
      await api('DELETE', '/user/starred/' + full, undefined, { fullName: full });
      if (gen !== state.reqGen) return; // 已切号/登出：丢弃本地副作用
      state.starredSet.delete(full); // C-3：同步维护，列表/搜索卡片才能回显
      repo.viewer_has_starred = false;
      repo.stargazers_count = Math.max(0, (repo.stargazers_count || 1) - 1);
      toast('已取消收藏');
    } else {
      await api('PUT', '/user/starred/' + full, undefined, { fullName: full });
      if (gen !== state.reqGen) return; // 已切号/登出：丢弃本地副作用
      state.starredSet.add(full); // C-3：同上
      repo.viewer_has_starred = true;
      repo.stargazers_count = (repo.stargazers_count || 0) + 1;
      toast('已收藏');
    }
    if (state.repo === repo) renderRepoDetail(); // 仅仍停留在同一仓库时才刷新详情
  } catch (e) { if (gen === state.reqGen) toast('操作失败：' + e.message, 'err'); }
}

async function forkRepo(){
  confirmModal({
    title: 'Fork 仓库',
    bodyHtml: '将 <b>' + esc(state.repo.full_name) + '</b> 复制一份到自己账号下？',
    required: state.repo.name,
    okText: '确认 Fork',
    onConfirm: async () => {
      const nw = await api('POST', '/repos/' + state.repo.full_name + '/forks', undefined, { fullName: state.repo.full_name });
      toast('Fork 已创建：' + nw.full_name);
      state.reposLoaded = false;
      loadRepos();
    },
  });
}

/* ================= 文件 ================= */
async function loadContents(){
  const gen = ++state.reqGen;
  const body = $('#repo-body');
  if (!body || !state.repo) return;
  body.innerHTML = '<div class="loading"><div class="spinner"></div>正在加载 ...</div>';
  try {
    const branch = state.branch || state.repo.default_branch;
    let p = '/repos/' + state.repo.full_name + '/contents';
    if (state.path) p += '/' + encPath(state.path);
    p += '?ref=' + encodeURIComponent(branch);
    const entries = await api('GET', p, undefined, { fullName: state.repo.full_name });
    if (gen !== state.reqGen) return;
    if (!Array.isArray(entries)) throw new Error('返回数据异常');
    entries.sort((a, b) => {
      const ta = a.type === 'dir' ? 0 : 1, tb = b.type === 'dir' ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    const crumbs = ['<span class="crumb" data-crumb="">根目录</span>'];
    if (state.path) {
      const parts = state.path.split('/');
      let acc = '';
      parts.forEach((seg, i) => {
        acc = acc ? acc + '/' + seg : seg;
        crumbs.push('<span class="crumb-sep">/</span><span class="crumb ' + (i === parts.length - 1 ? 'here' : '') + '" data-crumb="' + esc(acc) + '">' + esc(seg) + '</span>');
      });
    }
    body.innerHTML = `
      <div class="toolbar">
        <select class="btn" id="branch-sel" style="padding:8px 11px">
          ${state.branches.map(b => '<option value="' + esc(b.name) + '" ' + (b.name === branch ? 'selected' : '') + '>' + esc(b.name) + '</option>').join('')}
        </select>
        <div class="crumbs">${crumbs.join('')}</div>
        <button class="btn sm primary" style="margin-left:auto" id="btn-newfile">${icon('plus')} 新建文件</button>
        <button class="btn sm" id="btn-rf">${icon('refresh')}</button>
      </div>
      ${entries.length
        ? '<div class="row-list">' + entries.map(e => {
            const isDir = e.type === 'dir';
            return '<div class="row-item">' +
              '<span class="row-icon">' + icon(isDir ? 'folder' : 'file', 18) + '</span>' +
              '<div class="row-main"><div class="row-title" data-entry="' + esc(e.path) + '" data-type="' + esc(e.type) + '">' + esc(e.name) + '</div></div>' +
              '<div class="row-side">' + (isDir ? '文件夹' : fmtSize(e.size)) +
              (!isDir ? '<button class="btn sm danger-ghost" data-delfile="' + esc(e.path) + '" data-fsha="' + esc(e.sha) + '" data-fname="' + esc(e.name) + '">' + icon('trash') + '</button>' : '') +
              '</div></div>';
          }).join('') + '</div>'
        : '<div class="empty">' + icon('folder', 40) + '<div class="big">这个目录是空的</div></div>'}
    `;
    $('#branch-sel').addEventListener('change', ev => { state.branch = ev.target.value; state.path = ''; state.file = null; loadContents(); });
    $('#btn-newfile').addEventListener('click', openNewFile);
    $('#btn-rf').addEventListener('click', loadContents);
    $$('#repo-body [data-crumb]').forEach(c => c.addEventListener('click', () => { state.path = c.dataset.crumb; state.file = null; loadContents(); }));
    $$('#repo-body [data-entry]').forEach(t => t.addEventListener('click', () => {
      if (t.dataset.type === 'dir') { state.path = t.dataset.entry; state.file = null; loadContents(); }
      else openFile(t.dataset.entry);
    }));
    $$('#repo-body [data-delfile]').forEach(b => b.addEventListener('click', () => {
      confirmModal({
        title: '删除文件',
        bodyHtml: '永久删除 <b style="font-family:var(--mono)">' + esc(b.dataset.delfile) + '</b>？将产生一条删除提交。',
        required: 'DELETE',
        okText: '确认删除',
        onConfirm: async () => {
          await api('DELETE', '/repos/' + state.repo.full_name + '/contents/' + encPath(b.dataset.delfile),
            { message: '删除文件 ' + b.dataset.fname, sha: b.dataset.fsha, branch: state.branch || state.repo.default_branch },
            { fullName: state.repo.full_name });
          toast('文件已删除');
          loadContents();
        },
      });
    }));
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4：旧请求失败不得覆盖当前视图
    body.innerHTML = '<div class="card" style="border-color:var(--danger)"><b>加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}

async function openFile(path){
  const gen = ++state.reqGen; // C-2：读文件是异步，切 tab/切仓库后旧响应不得覆盖当前视图
  const body = $('#repo-body');
  body.innerHTML = '<div class="loading"><div class="spinner"></div>正在读取文件 ...</div>';
  try {
    const branch = state.branch || state.repo.default_branch;
    const f = await api('GET', '/repos/' + state.repo.full_name + '/contents/' + encPath(path) + '?ref=' + encodeURIComponent(branch), undefined, { fullName: state.repo.full_name });
    if (gen !== state.reqGen) return; // 旧响应：静默退出，不写 state.file、不覆盖 #repo-body
    state.file = f;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const isImage = IMG_EXT.includes(ext);
    const tooBig = f.size > 1000000;
    let canEdit = true; // 二进制/图片/超大文件禁止进文本编辑器（base64 往返不可逆，保存即损坏）
    let inner;
    if (tooBig) { inner = '<div class="empty">' + icon('file', 40) + '<div class="big">文件超过 1MB，不直接预览</div></div>'; canEdit = false; }
    else if (isImage) { inner = '<img class="img-view" src="data:image/' + (ext === 'svg' ? 'svg+xml' : ext) + ';base64,' + f.content.replace(/\s/g, '') + '" alt="">'; canEdit = false; }
    else if (f.encoding === 'base64') {
      const raw = atob(f.content.replace(/\s/g, ''));
      let binary = false;
      for (let i = 0; i < Math.min(raw.length, 1024); i++) if (raw.charCodeAt(i) === 0) { binary = true; break; }
      if (binary) { inner = '<div class="empty">' + icon('file', 40) + '<div class="big">二进制文件，不直接预览</div><div>可在网页端或下载后查看</div></div>'; canEdit = false; }
      else inner = '<pre class="code">' + esc(b64ToUtf8(f.content)) + '</pre>';
    } else inner = '<pre class="code">' + esc(f.content || '') + '</pre>';
    body.innerHTML = `
      <div class="file-head">
        <button class="btn sm" data-act="loadContents">${icon('back')} 返回目录</button>
        <span class="file-name">${esc(f.name)}</span>
        <span style="color:var(--muted);font-size:12.5px">${fmtSize(f.size)}</span>
        ${canEdit ? '<button class="btn sm primary" id="btn-editfile">' + icon('edit') + ' 编辑</button>' : ''}
        ${f.html_url ? '<a class="btn sm" href="' + esc(f.html_url) + '" target="_blank">' + icon('ext') + ' 网页</a>' : ''}
        ${f.download_url ? '<a class="btn sm" id="btn-download" href="' + esc(f.download_url) + '">' + icon('download') + ' 下载</a>' : ''}
      </div>
      ${inner}
    `;
    const eb = $('#btn-editfile');
    if (eb) eb.addEventListener('click', () => openFileEditor(f));
    const dl = $('#btn-download');
    if (dl) dl.addEventListener('click', (e) => {
      // 跨域 <a download> 的 download 属性会被浏览器忽略 → 退化成同标签页导航 → 被 desktop.cjs 的 will-navigate 拦掉（点了没反应）。
      // 改走主进程桥接：主进程先弹「另存为」对话框（取消则不发请求），确认后 downloadURL 落盘，等下载真正结束再回结果，
      // 故此处按真实结果如实提示（已保存到 <路径> / 用户取消 / 下载失败），不再无条件报成功。
      e.preventDefault();
      const label = dl.innerHTML;
      dl.classList.add('disabled'); dl.style.pointerEvents = 'none';
      dl.innerHTML = icon('download') + ' 下载中…';
      fetch(bridgeURL('download', '&url=' + encodeURIComponent(dl.getAttribute('href'))))
        .then(r => r.json())
        .then(d => {
          if (d && d.ok) toast('已保存到 ' + (d.path || '所选位置'));
          else if (d && d.canceled) { /* 用户取消另存为：不报错 */ }
          else toast('下载失败' + (d && d.error ? '：' + d.error : ''), 'err');
        })
        .catch(() => toast('下载失败：无法连接本地服务', 'err'))
        .finally(() => { dl.innerHTML = label; dl.classList.remove('disabled'); dl.style.pointerEvents = ''; });
    });
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4：旧请求失败不得覆盖当前视图
    body.innerHTML = '<div class="card" style="border-color:var(--danger)"><b>读取失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}

function fileEditorModal(title, path, content, sha){
  openModal(`
    <div class="m-title">${esc(title)}</div>
    <div class="m-field"><label class="field-label">文件路径（如 src/main.py）</label>
      <input class="m-input" id="fe-path" style="font-family:var(--mono)" value="${esc(path)}" ${sha ? 'readonly style="font-family:var(--mono);opacity:.7"' : ''}></div>
    <div class="m-field"><label class="field-label">文件内容</label>
      <textarea class="m-textarea" id="fe-content" style="min-height:220px">${esc(content)}</textarea></div>
    <div class="m-field"><label class="field-label">提交信息（Commit message）</label>
      <input class="m-input" id="fe-msg" placeholder="例如：更新配置 / fix typo"></div>
    <div class="m-actions">
      <button class="btn" id="fe-cancel">取消</button>
      <button class="btn primary" id="fe-ok">${icon('check')} 提交</button>
    </div>
  `);
  $('#fe-cancel').addEventListener('click', closeModal);
  $('#fe-content').focus();
  $('#fe-ok').addEventListener('click', async () => {
    const __ok = $('#fe-ok'); if (__ok.disabled) return;
    const p = $('#fe-path').value.trim().replace(/^\/+/, '');
    const content = $('#fe-content').value;
    const msg = $('#fe-msg').value.trim() || ('更新 ' + p);
    if (!p) { toast('请填写文件路径', 'err'); return; }
    __ok.disabled = true;
    try {
      const payload = { message: msg, content: utf8ToB64(content), branch: state.branch || state.repo.default_branch };
      if (sha) payload.sha = sha;
      if (activeAccount() && activeAccount().platform === 'gitlab') payload.encoding = 'base64';
      await api('PUT', '/repos/' + state.repo.full_name + '/contents/' + encPath(p), payload, { fullName: state.repo.full_name });
      toast('已提交到 ' + (state.branch || state.repo.default_branch) + ' 分支');
      closeModal();
      state.path = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      loadContents();
    } catch (e) { __ok.disabled = false; toast('提交失败：' + e.message, 'err'); }
  });
}
function openFileEditor(f){
  const content = f.encoding === 'base64' ? b64ToUtf8(f.content) : (f.content || '');
  fileEditorModal('编辑文件', f.path, content, f.sha);
}
function openNewFile(){
  const base = state.path ? state.path + '/' : '';
  fileEditorModal('新建文件', base, '', null);
}

/* ================= Commits ================= */
async function loadCommits(){
  const gen = ++state.reqGen;
  const body = $('#repo-body');
  body.innerHTML = '<div class="loading"><div class="spinner"></div>正在加载提交历史 ...</div>';
  try {
    const branch = state.branch || state.repo.default_branch;
    const list = await api('GET', '/repos/' + state.repo.full_name + '/commits?sha=' + encodeURIComponent(branch) + '&per_page=30', undefined, { fullName: state.repo.full_name });
    if (gen !== state.reqGen) return;
    body.innerHTML = `
      <div class="toolbar"><span style="color:var(--muted);font-size:13px">分支 <b>${esc(branch)}</b> 的最近提交，点击可在浏览器查看完整改动</span></div>
      ${list.length
        ? '<div class="row-list">' + list.map(c => `
          <a class="row-item" href="${esc(c.html_url)}" target="_blank" style="text-decoration:none;color:inherit">
            <span class="row-icon">${icon('commit', 18)}</span>
            <div class="row-main">
              <div class="row-title plain" style="cursor:default">${esc((c.commit.message || '').split('\n')[0])}</div>
              <div class="row-sub"><span style="font-family:var(--mono)">${esc((c.sha || '').slice(0, 7))}</span> · ${esc(c.commit.author ? c.commit.author.name : '')} · ${timeAgo(c.commit.author ? c.commit.author.date : '')}</div>
            </div>
            <div class="row-side">${icon('ext')}</div>
          </a>`).join('') + '</div>'
        : '<div class="empty">' + icon('commit', 40) + '<div class="big">没有提交记录</div></div>'}
    `;
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4：旧请求失败不得覆盖当前视图
    body.innerHTML = '<div class="card" style="border-color:var(--danger)"><b>加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}

/* ================= 分支 ================= */
async function loadBranches(){
  const gen = ++state.reqGen;
  const body = $('#repo-body');
  body.innerHTML = '<div class="loading"><div class="spinner"></div>正在加载分支 ...</div>';
  try {
    const branches = await api('GET', '/repos/' + state.repo.full_name + '/branches?per_page=100', undefined, { fullName: state.repo.full_name });
    if (gen !== state.reqGen) return; // 赋值必须在守卫之后：否则切号/切仓库时旧响应会污染 state.branches
    state.branches = branches;
    body.innerHTML = `
      <div class="toolbar">
        <button class="btn primary sm" id="btn-newbranch">${icon('plus')} 新建分支</button>
        <span style="color:var(--muted);font-size:13px">默认分支不可删除</span>
      </div>
      <div class="row-list">
        ${state.branches.map(b => {
          const isDef = b.name === state.repo.default_branch;
          return '<div class="row-item">' +
            '<span class="row-icon">' + icon('branch', 18) + '</span>' +
            '<div class="row-main"><div class="row-title plain" style="cursor:default">' + esc(b.name) + '</div>' +
            '<div class="row-sub">最新提交 <span style="font-family:var(--mono)">' + esc((b.commit && b.commit.sha || '').slice(0, 7)) + '</span></div></div>' +
            '<div class="row-side">' + (isDef ? '<span class="badge def">默认</span>' : '<button class="btn sm danger-ghost" data-delbranch="' + esc(b.name) + '">删除</button>') + '</div></div>';
        }).join('')}
      </div>
    `;
    $('#btn-newbranch').addEventListener('click', openNewBranch);
    $$('#repo-body [data-delbranch]').forEach(btn => btn.addEventListener('click', () => deleteBranch(btn.dataset.delbranch)));
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4：旧请求失败不得覆盖当前视图
    body.innerHTML = '<div class="card" style="border-color:var(--danger)"><b>加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}
function openNewBranch(){
  const def = state.branches.find(b => b.name === state.repo.default_branch);
  const defSha = def ? def.commit.sha : '';
  openModal(`
    <div class="m-title">新建分支</div>
    <div class="m-field"><label class="field-label">分支名（如 dev / feature-x）</label>
      <input class="m-input" id="nb-name" style="font-family:var(--mono)" placeholder="不能包含空格和 ~ ^ : ? * [ \\" autocomplete="off"></div>
    <p class="m-text">将基于默认分支 <b>${esc(state.repo.default_branch)}</b> 创建</p>
    <div class="m-actions">
      <button class="btn" id="nb-cancel">取消</button>
      <button class="btn primary" id="nb-ok">${icon('plus')} 创建</button>
    </div>
  `);
  $('#nb-cancel').addEventListener('click', closeModal);
  $('#nb-name').focus();
  $('#nb-ok').addEventListener('click', async () => {
    const __ok = $('#nb-ok'); if (__ok.disabled) return;
    const name = $('#nb-name').value.trim();
    if (!name) { toast('请填写分支名', 'err'); return; }
    __ok.disabled = true;
    try {
      await api('POST', '/repos/' + state.repo.full_name + '/git/refs', { ref: 'refs/heads/' + name, sha: defSha }, { fullName: state.repo.full_name });
      toast('分支 ' + name + ' 已创建');
      closeModal();
      loadBranches();
    } catch (e) { __ok.disabled = false; toast('创建失败：' + e.message, 'err'); }
  });
}
function deleteBranch(name){
  if (name === state.repo.default_branch) { toast('默认分支不能删除', 'err'); return; }
  confirmModal({
    title: '删除分支',
    bodyHtml: '即将删除分支 <b style="font-family:var(--mono)">' + esc(name) + '</b>，该分支上未合并的提交将丢失。',
    required: name,
    okText: '确认删除',
    onConfirm: async () => {
      await api('DELETE', '/repos/' + state.repo.full_name + '/git/refs/heads/' + encodeURIComponent(name), undefined, { fullName: state.repo.full_name });
      toast('分支已删除');
      loadBranches();
    },
  });
}

/* ================= Issues ================= */
async function loadIssues(){
  const gen = ++state.reqGen;
  const body = $('#repo-body');
  body.innerHTML = '<div class="loading"><div class="spinner"></div>正在加载 Issues ...</div>';
  try {
    const all = await api('GET', '/repos/' + state.repo.full_name + '/issues?state=' + state.issueFilter + '&per_page=100&sort=created&direction=desc', undefined, { fullName: state.repo.full_name });
    if (gen !== state.reqGen) return;
    state.issues = all.filter(x => !x.pull_request);
    body.innerHTML = `
      <div class="toolbar">
        <div class="chips">
          ${[['open','开启'],['closed','已关闭'],['all','全部']].map(([k, l]) =>
            '<button class="chip ' + (state.issueFilter === k ? 'active' : '') + '" data-ifilter="' + k + '">' + l + '</button>').join('')}
        </div>
        <button class="btn primary sm" style="margin-left:auto" data-act="openNewIssue">${icon('plus')} 新建 Issue</button>
      </div>
      ${state.issues.length
        ? '<div class="row-list">' + state.issues.map(x => {
            const open = x.state === 'open';
            const labels = (x.labels || []).map(l =>
              '<span class="label-pill" style="background:#' + (/^[0-9a-fA-F]{6}$/.test(l.color || '') ? l.color : '6d8cff') + ';color:#1f2937">' + esc(l.name) + '</span>').join(' ');
            return '<div class="row-item">' +
              '<span class="row-icon">' + icon('issue', 18) + '</span>' +
              '<div class="row-main"><div class="row-title plain" style="cursor:default">#' + x.number + ' ' + esc(x.title) + '</div>' +
              '<div class="row-sub">' + esc(x.user ? x.user.login : '') + ' 创建于 ' + timeAgo(x.created_at) +
              (x.comments ? ' · ' + x.comments + ' 条评论' : '') + (labels ? ' · ' + labels : '') + '</div></div>' +
              '<div class="row-side"><span class="badge ' + (open ? 'open' : 'closed') + '">' + (open ? '开启' : '已关闭') + '</span>' +
              '<button class="btn sm" data-icomment="' + x.number + '">' + icon('comment') + '</button>' +
              '<button class="btn sm" data-itoggle="' + x.number + '" data-inow="' + x.state + '">' + (open ? '关闭' : '重开') + '</button>' +
              '<a class="btn sm" href="' + esc(x.html_url) + '" target="_blank">' + icon('ext') + '</a></div></div>';
          }).join('') + '</div>'
        : '<div class="empty">' + icon('issue', 40) + '<div class="big">没有 Issue</div></div>'}
    `;
    $$('#repo-body [data-ifilter]').forEach(c => c.addEventListener('click', () => { state.issueFilter = c.dataset.ifilter; loadIssues(); }));
    $$('#repo-body [data-itoggle]').forEach(b => b.addEventListener('click', () => toggleIssue(Number(b.dataset.itoggle), b.dataset.inow === 'open' ? 'closed' : 'open')));
    $$('#repo-body [data-icomment]').forEach(b => b.addEventListener('click', () => openIssueComment(Number(b.dataset.icomment))));
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4：旧请求失败不得覆盖当前视图
    body.innerHTML = '<div class="card" style="border-color:var(--danger)"><b>加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}
async function toggleIssue(num, newState){
  try {
    await api('PATCH', '/repos/' + state.repo.full_name + '/issues/' + num, { state: newState }, { fullName: state.repo.full_name });
    toast('Issue #' + num + ' 已' + (newState === 'open' ? '重新打开' : '关闭'));
    loadIssues();
  } catch (e) { toast('操作失败：' + e.message, 'err'); }
}
function openIssueComment(num){
  openModal(`
    <div class="m-title">评论 Issue #${num}</div>
    <div class="m-field"><textarea class="m-textarea" id="ic-body" style="min-height:150px" placeholder="支持 Markdown"></textarea></div>
    <div class="m-actions">
      <button class="btn" id="ic-cancel">取消</button>
      <button class="btn primary" id="ic-ok">${icon('comment')} 发表评论</button>
    </div>
  `);
  $('#ic-cancel').addEventListener('click', closeModal);
  $('#ic-body').focus();
  $('#ic-ok').addEventListener('click', async () => {
    const __ok = $('#ic-ok'); if (__ok.disabled) return;
    const body = $('#ic-body').value.trim();
    if (!body) { toast('评论不能为空', 'err'); return; }
    __ok.disabled = true;
    try {
      await api('POST', '/repos/' + state.repo.full_name + '/issues/' + num + '/comments', { body }, { fullName: state.repo.full_name });
      toast('评论已发表');
      closeModal();
    } catch (e) { __ok.disabled = false; toast('评论失败：' + e.message, 'err'); }
  });
}
function openNewIssue(){
  openModal(`
    <div class="m-title">新建 Issue</div>
    <div class="m-field"><label class="field-label">标题</label>
      <input class="m-input" id="is-title" autocomplete="off"></div>
    <div class="m-field"><label class="field-label">内容（可选，支持 Markdown）</label>
      <textarea class="m-textarea" id="is-body"></textarea></div>
    <div class="m-actions">
      <button class="btn" id="is-cancel">取消</button>
      <button class="btn primary" id="is-ok">${icon('plus')} 创建</button>
    </div>
  `);
  $('#is-cancel').addEventListener('click', closeModal);
  $('#is-title').focus();
  $('#is-ok').addEventListener('click', async () => {
    const __ok = $('#is-ok'); if (__ok.disabled) return;
    const title = $('#is-title').value.trim();
    if (!title) { toast('请填写标题', 'err'); return; }
    __ok.disabled = true;
    try {
      await api('POST', '/repos/' + state.repo.full_name + '/issues', { title, body: $('#is-body').value }, { fullName: state.repo.full_name });
      toast('Issue 创建成功');
      closeModal();
      state.issueFilter = 'open';
      loadIssues();
    } catch (e) { __ok.disabled = false; toast('创建失败：' + e.message, 'err'); }
  });
}

/* ================= PR ================= */
async function loadPulls(){
  const gen = ++state.reqGen;
  const body = $('#repo-body');
  body.innerHTML = '<div class="loading"><div class="spinner"></div>正在加载 PR ...</div>';
  try {
    const list = await api('GET', '/repos/' + state.repo.full_name + '/pulls?state=all&per_page=50', undefined, { fullName: state.repo.full_name });
    if (gen !== state.reqGen) return;
    body.innerHTML = `
      <div class="toolbar"><span style="color:var(--muted);font-size:13px">PR 的合并、Review 等操作请到网页进行，点击行可直达</span></div>
      ${list.length
        ? '<div class="row-list">' + list.map(x => {
            const merged = x.merged === true || !!x.merged_at;
            const open = !merged && x.state === 'open';
            return '<a class="row-item" href="' + esc(x.html_url) + '" target="_blank" style="text-decoration:none;color:inherit">' +
              '<span class="row-icon">' + icon('pr', 18) + '</span>' +
              '<div class="row-main"><div class="row-title plain" style="cursor:default">#' + x.number + ' ' + esc(x.title) + '</div>' +
              '<div class="row-sub">' + esc(x.user ? x.user.login : '') + ' · ' + esc((x.head && x.head.ref) || '') + ' → ' + esc((x.base && x.base.ref) || '') + ' · ' + timeAgo(x.updated_at) + '</div></div>' +
              '<div class="row-side"><span class="badge ' + (merged ? 'merged' : open ? 'open' : 'closed') + '">' + (merged ? '已合并' : open ? '开启' : '已关闭') + '</span><button class="btn sm" data-prfiles="' + x.number + '" title="查看变更文件">变更</button></div></a>';
          }).join('') + '</div>'
        : '<div class="empty">' + icon('pr', 40) + '<div class="big">没有 PR</div></div>'}
    `;
    $$('#repo-body [data-prfiles]').forEach(b => b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openPrFiles(Number(b.dataset.prfiles));
    }));
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4：旧请求失败不得覆盖当前视图
    body.innerHTML = '<div class="card" style="border-color:var(--danger)"><b>加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}

/* ================= PR 变更文件 ================= */
async function openPrFiles(num){
  const gen = ++state.reqGen; // R3-DEF4：写 #modal 的请求也必须递增代际——弹窗不像 #repo-body 会被 renderRepoDetail 重建，
  // 若只捕获不递增，两连点「变更」时旧 PR 响应会覆盖用户最后点开的弹窗
  try {
    const files = await api('GET', '/repos/' + state.repo.full_name + '/pulls/' + num + '/files?per_page=100', undefined, { fullName: state.repo.full_name });
    if (gen !== state.reqGen) return;
    const rows = files.map(f => {
      const stName = { added: '新增', removed: '删除', modified: '修改', renamed: '重命名' }[f.status] || (f.status || '');
      const stCls = f.status === 'added' ? 'open' : f.status === 'removed' ? 'closed' : 'runrun';
      const patchLines = f.patch ? f.patch.split('\n') : [];
      const truncated = patchLines.length > 200;
      const patchHtml = patchLines.length
        ? '<div class="code" style="max-height:260px">' + esc(patchLines.slice(0, 200).join('\n')) + (truncated ? '\n... (差异过长，已截断)' : '') + '</div>'
        : '<div style="color:var(--muted);font-size:12px">（无文本差异，可能是二进制文件）</div>';
      return '<div style="margin:14px 0 6px;font-family:var(--mono);font-size:12px;font-weight:650">' + esc(f.filename || '') +
        ' <span class="badge ' + stCls + '">' + esc(stName) + '</span></div>' + patchHtml;
    }).join('');
    openModal('<div class="m-title">PR #' + num + ' 变更文件（' + files.length + '）</div>' +
      '<div style="max-height:64vh;overflow-y:auto">' + (rows || '<div class="empty">没有变更</div>') + '</div>' +
      '<div class="m-actions"><button class="btn primary" data-act="closeModal">关闭</button></div>');
  } catch (e) {
    toast('变更加载失败：' + e.message, 'err');
  }
}

/* ================= Releases ================= */
async function loadReleases(){
  const gen = ++state.reqGen;
  const body = $('#repo-body');
  body.innerHTML = '<div class="loading"><div class="spinner"></div>正在加载 Releases ...</div>';
  try {
    const list = await api('GET', '/repos/' + state.repo.full_name + '/releases?per_page=30', undefined, { fullName: state.repo.full_name });
    if (gen !== state.reqGen) return;
    body.innerHTML = `
      <div class="toolbar"><span style="color:var(--muted);font-size:13px">发布新 Release 请打 Tag 后到网页操作；这里可以删除不需要的 Release</span></div>
      ${list.length
        ? '<div class="row-list">' + list.map(x => {
            const kind = x.draft ? '<span class="badge closed">草稿</span>' : x.prerelease ? '<span class="badge pri">预发布</span>' : '<span class="badge pub">正式</span>';
            return '<div class="row-item">' +
              '<span class="row-icon">' + icon('tag', 18) + '</span>' +
              '<div class="row-main"><div class="row-title plain" style="cursor:default">' + esc(x.name || x.tag_name) + '</div>' +
              '<div class="row-sub">Tag: <span style="font-family:var(--mono)">' + esc(x.tag_name) + '</span> · ' + esc(x.author ? x.author.login : '') + ' · ' + timeAgo(x.published_at) +
              (x.assets && x.assets.length ? ' · ' + x.assets.length + ' 个附件' : '') + '</div></div>' +
              '<div class="row-side">' + kind +
              '<button class="btn sm danger-ghost" data-rdel="' + esc(x.id) + '" data-rtag="' + esc(x.tag_name) + '">' + icon('trash') + '</button>' +
              '<a class="btn sm" href="' + esc(x.html_url) + '" target="_blank">' + icon('ext') + '</a></div></div>';
          }).join('') + '</div>'
        : '<div class="empty">' + icon('tag', 40) + '<div class="big">没有 Release</div></div>'}
    `;
    $$('#repo-body [data-rdel]').forEach(b => b.addEventListener('click', () => {
      confirmModal({
        title: '删除 Release',
        bodyHtml: '即将删除 Release <b style="font-family:var(--mono)">' + esc(b.dataset.rtag) + '</b>（不影响 Tag 本身和已上传的附件存档）。',
        required: b.dataset.rtag,
        okText: '确认删除',
        onConfirm: async () => {
          await api('DELETE', '/repos/' + state.repo.full_name + '/releases/' + b.dataset.rdel, undefined, { fullName: state.repo.full_name });
          toast('Release 已删除');
          loadReleases();
        },
      });
    }));
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4：旧请求失败不得覆盖当前视图
    body.innerHTML = '<div class="card" style="border-color:var(--danger)"><b>加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}

/* ================= Actions ================= */
function runBadge(run){
  if (run.status !== 'completed')
    return '<span class="badge runrun">' + esc(run.status === 'in_progress' ? '运行中' : run.status === 'queued' ? '排队中' : run.status) + '</span>';
  const c = run.conclusion;
  if (c === 'success') return '<span class="badge runok">成功</span>';
  if (c === 'failure' || c === 'timed_out' || c === 'startup_failure') return '<span class="badge runbad">失败</span>';
  if (c === 'cancelled') return '<span class="badge closed">已取消</span>';
  return '<span class="badge closed">' + esc(c || '完成') + '</span>';
}
async function loadRuns(){
  const body = $('#repo-body');
  const gen = ++state.reqGen; // ENG-3：其余 loader 均 ++，唯此处曾只捕获——Actions 先渲染、文件列表晚到时旧响应会覆盖当前 tab
  body.innerHTML = '<div class="loading"><div class="spinner"></div>正在加载 Actions ...</div>';
  try {
    const res = await api('GET', '/repos/' + state.repo.full_name + '/actions/runs?per_page=20', undefined, { fullName: state.repo.full_name });
    if (gen !== state.reqGen) return;
    const list = res.workflow_runs || [];
    body.innerHTML = `
      <div class="toolbar"><span style="color:var(--muted);font-size:13px">最近 20 次 Workflow 运行，日志与重跑请到网页</span></div>
      ${list.length
        ? '<div class="row-list">' + list.map(x => `
          <a class="row-item" href="${esc(x.html_url)}" target="_blank" style="text-decoration:none;color:inherit">
            <span class="row-icon">${icon('zap', 18)}</span>
            <div class="row-main">
              <div class="row-title plain" style="cursor:default">${esc(x.display_title || x.name || '')}</div>
              <div class="row-sub">${esc(x.name || '')} · #${x.run_number} · ${esc(x.event)} · ${esc(x.head_branch || '')} · ${timeAgo(x.created_at)}</div>
            </div>
            <div class="row-side">${runBadge(x)}</div>
          </a>`).join('') + '</div>'
        : '<div class="empty">' + icon('zap', 40) + '<div class="big">这个仓库没有配置 Actions 工作流</div></div>'}
    `;
  } catch (e) {
    if (gen !== state.reqGen) return; // C-4：旧请求失败不得覆盖当前视图
    body.innerHTML = '<div class="card" style="border-color:var(--danger)"><b>加载失败</b><br><span style="color:var(--muted)">' + esc(e.message) + '</span></div>';
  }
}

/* ================= 仓库设置 ================= */
function renderRepoSettings(){
  const r = state.repo;
  const body = $('#repo-body');
  body.innerHTML = `
    <div class="card" style="margin-bottom:15px">
      <div class="m-title">基本信息</div>
      <div class="form-row">
        <div class="m-field"><label class="field-label">仓库名称</label>
          <input class="m-input" id="rs-name" value="${esc(r.name)}" style="font-family:var(--mono)"></div>
        <button class="btn primary" id="rs-name-save">${icon('check')} 保存</button>
      </div>
      <div class="form-row">
        <div class="m-field"><label class="field-label">描述</label>
          <input class="m-input" id="rs-desc" value="${esc(r.description || '')}"></div>
        <button class="btn primary" id="rs-desc-save">${icon('check')} 保存</button>
      </div>
      <div class="form-row">
        <div class="m-field"><label class="field-label">默认分支</label>
          <select class="m-input" id="rs-db" style="padding:10px 14px">
            ${state.branches.map(b => '<option value="' + esc(b.name) + '" ' + (b.name === r.default_branch ? 'selected' : '') + '>' + esc(b.name) + '</option>').join('')}
          </select></div>
        <button class="btn primary" id="rs-db-save">${icon('check')} 保存</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:15px">
      <div class="m-title">可见性</div>
      <div class="radio-row" style="margin-bottom:10px">
        <label><input type="radio" name="rs-vis" value="private" ${r.private ? 'checked' : ''}> 私有</label>
        <label><input type="radio" name="rs-vis" value="public" ${!r.private ? 'checked' : ''}> 公开</label>
      </div>
      <button class="btn" id="rs-vis-save">${icon('check')} 应用可见性</button>
    </div>
    <div class="card" style="margin-bottom:15px">
      <div class="m-title">仓库操作</div>
      <div class="page-actions">
        <button class="btn" id="rs-archive">${icon('archive')} ${r.archived ? '取消归档' : '归档仓库'}</button>
        <button class="btn" id="rs-fork">${icon('fork')} Fork 到自己账号</button>
        <button class="btn" id="rs-star2">${icon(isStarred() ? 'starFill' : 'star')} ${isStarred() ? '取消收藏' : '收藏'}</button>
      </div>
    </div>
    <div class="card" style="border-color:var(--danger)">
      <div class="m-title danger">危险区</div>
      <p class="m-text">删除仓库将永久移除全部代码、Issue、PR、Release 和 Wiki，不可恢复。</p>
      <button class="btn danger" id="rs-delete">${icon('trash')} 删除此仓库</button>
    </div>
  `;
  $('#rs-name-save').addEventListener('click', () => patchRepo({ name: $('#rs-name').value.trim() }, '名称已更新'));
  $('#rs-desc-save').addEventListener('click', () => patchRepo({ description: $('#rs-desc').value.trim() }, '描述已更新'));
  $('#rs-db-save').addEventListener('click', () => patchRepo({ default_branch: $('#rs-db').value }, '默认分支已更新'));
  $('#rs-vis-save').addEventListener('click', () => {
    const priv = document.querySelector('[name=rs-vis]:checked').value === 'private';
    confirmModal({
      title: '修改可见性',
      bodyHtml: priv ? '即将把仓库设为<b>私有</b>。' : '即将把仓库设为<b>公开</b>，任何人都能看到仓库内容！',
      required: state.repo.name,
      okText: '确认修改',
      onConfirm: () => patchRepo({ private: priv }, '可见性已更新'),
    });
  });
  $('#rs-archive').addEventListener('click', () => patchRepo({ archived: !r.archived }, r.archived ? '已取消归档' : '已归档（变为只读）'));
  $('#rs-fork').addEventListener('click', forkRepo);
  $('#rs-star2').addEventListener('click', starToggle);
  $('#rs-delete').addEventListener('click', () => deleteModal([state.repo], () => {
    state.reposLoaded = false;
    loadRepos();
    showView('repos');
  }));
}
async function patchRepo(fields, okMsg){
  const gen = state.reqGen;              // 代际守卫：在途切仓库/切号后旧响应不得覆盖当前仓库
  const full = state.repo.full_name;     // 捕获调用时的仓库，避免 await 后读实时 state.repo
  try {
    const updated = await api('PATCH', '/repos/' + full, fields, { fullName: full });
    if (gen !== state.reqGen) return;    // 已切仓库/切号，丢弃旧响应
    state.repo = updated;
    toast(okMsg);
    state.reposLoaded = false;
    loadRepos();
    renderRepoDetail();
    ({ files: loadContents, commits: loadCommits, branches: loadBranches,
       issues: loadIssues, pulls: loadPulls, releases: loadReleases,
       actions: loadRuns, settings: renderRepoSettings }[state.tab] || (() => {}))();
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
}

/* ---------------- 关闭询问 ---------------- */
// 点窗口 × 时由主进程 desktop.cjs 通过 webContents.executeJavaScript 调用 window.showCloseAsk()（本项目为 Electron，无 Python 侧）
function showCloseAsk(){
  openModal(`
    <div class="m-title">关闭 Git 控制台</div>
    <p class="m-text">要退出程序，还是最小化到系统托盘继续在后台运行？后台时点击托盘的小猫图标即可随时唤回。</p>
    <label class="m-check" style="margin-bottom:4px"><input type="checkbox" id="ca-remember"> 记住我的选择，以后点 × 不再询问（可在「设置」页改回）</label>
    <div class="m-actions" style="justify-content:space-between">
      <button class="btn primary" id="ca-tray">${icon('moon')} 最小化到后台</button>
      <button class="btn danger" id="ca-exit">${icon('logout')} 退出程序</button>
    </div>
  `);
  $('#ca-tray').addEventListener('click', () => {
    const remember = $('#ca-remember').checked ? '&remember=1' : '';
    closeModal();
    fetch(bridgeURL('minimize', remember)).catch(() => {});
  });
  $('#ca-exit').addEventListener('click', () => {
    const remember = $('#ca-remember').checked ? '&remember=1' : '';
    closeModal();
    fetch(bridgeURL('exit', remember)).catch(() => {});
  });
  return false;
}
window.showCloseAsk = showCloseAsk;

/* ---------------- 拖拽上传 ---------------- */
function bytesToB64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
async function fileToB64(file) {
  const buf = await file.arrayBuffer();
  return bytesToB64(new Uint8Array(buf));
}
// 阈值与绝对上限：两者职责不同，不可混为一谈。
//   DROP_SUGGEST：建议单次上限。超过即弹确认框让用户显式选择「全部 / 仅前 N 个 / 取消」——
//     原因同旧注释：Contents API 每文件一次请求，串行传上千文件会触发平台限流，需先征得用户同意。
//   MAX_DROP_LIMIT：绝对上限。防「误拖整个 C 盘」的兜底；超过直接拒绝并说明，绝不静默丢文件。
const DROP_SUGGEST = 60;
const MAX_DROP_LIMIT = 5000;
// 「记住我的选择」的持久化键：前端偏好一律走 localStorage（与 ghc_theme / gc_active 同法），不动 desktop.cjs、不加桥接口。
const UPLOAD_PREF_KEY = 'gc_upload_pref';
function loadUploadPref() {
  try {
    const v = JSON.parse(localStorage.getItem(UPLOAD_PREF_KEY) || 'null');
    if (!v || typeof v !== 'object') return null;
    if (v.mode !== 'all' && v.mode !== 'first' && v.mode !== 'cancel') return null; // 白名单：未知值一律当作「未记住」，回到询问
    const limit = Math.floor(Number(v.limit));
    return { mode: v.mode, limit: Number.isFinite(limit) && limit > 0 ? limit : DROP_SUGGEST };
  } catch (e) { return null; }
}
function saveUploadPref(mode, limit) {
  try { localStorage.setItem(UPLOAD_PREF_KEY, JSON.stringify({ mode, limit: limit || DROP_SUGGEST })); } catch (e) {}
}
function clearUploadPref() {
  try { localStorage.removeItem(UPLOAD_PREF_KEY); } catch (e) {}
}
function uploadPrefLabel(p) {
  if (!p) return '每次都询问';
  if (p.mode === 'all') return '不再询问，始终上传全部';
  if (p.mode === 'first') return '不再询问，始终仅上传前 ' + p.limit + ' 个';
  return '不再询问，拖入超量文件时直接取消';
}

/* ============ .gitignore 极简实现（拖拽上传尊重拖入目录内的 .gitignore） ============
   背景：用户拖 STM32 工程同步云端，Keil 编译产物（.o/.d/.crf）每次编译都变，反复上传必撞平台 SHA 冲突；
   工程侧 .gitignore 已排除这些产物——但拖拽上传此前并不认识 .gitignore，等于假开关。
   支持子集：#注释 / 空行 / !取反（后匹配优先）/ 结尾/仅目录 / 含/或开头/即锚定规则文件所在目录 /
   段内 * 与 ? 通配 / ** 跨段（可匹配零或多层）。不支持字符组 []（拖拽同步场景用不到，按字面处理）。
   仅纯函数、自包含——可被源码提取式测试直接运行（tests/gitignore-upload.test.mjs）。 */
function parseGitignore(text) {
  const rules = [];
  const segToRe = (s) => {
    let out = '';
    for (const c of s) {
      if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else if ('.+^${}()|[]\\'.includes(c)) out += '\\' + c;
      else out += c;
    }
    return out;
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    if (!line) continue;
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    if (!line) continue;
    let anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    else if (line.includes('/')) anchored = true; // git 语义：含 / 的模式相对规则文件所在目录锚定
    if (!line) continue;
    const segs = line.split('/');
    let re = '';
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] === '**') {
        re += '(?:[^/]+/)*';
        if (i === segs.length - 1) re += '.*'; // 结尾 ** = 该目录下全部内容
        continue;
      }
      re += segToRe(segs[i]);
      if (i < segs.length - 1) re += '/';
    }
    // 非锚定模式在任意层级生效（匹配某段路径）；锚定模式从规则文件目录根部起算
    re = anchored ? '^(?:' + re + ')(/|$)' : '(^|/)(?:' + re + ')(/|$)';
    try { rules.push({ negate, dirOnly, re: new RegExp(re) }); }
    catch (e) { /* 非法模式跳过，不阻断收集 */ }
  }
  return rules;
}
// chain = [{ base, rules }]：base 是该 .gitignore 所在目录前缀，规则只匹配其子树相对路径；
// 后匹配优先：链上更深的 .gitignore 追加在后，天然覆盖浅层规则（与 git 语义一致）。
function gitignoreMatch(chain, fullPath, isDir) {
  let ignored = false;
  for (const link of chain) {
    // 必须真前缀校验：只按长度 slice 会让子树外的路径错位出残串，被规则误判（回归测试抓过这个真 bug）
    if (!fullPath.startsWith(link.base)) continue;
    const rel = fullPath.slice(link.base.length);
    for (const r of link.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ignored = !r.negate;
    }
  }
  return ignored;
}

async function collectDropped(items) {
  const out = [];
  let overflow = false; // 超过绝对上限时置真——调用方据此「明确拒绝」，而非静默保留前 N 个
  let ignored = 0;      // 被 .gitignore 规则跳过的条目数（被忽略目录按 1 计，不计其内部文件数）——如实回传给确认框展示，绝不静默
  // 显式 FIFO 队列迭代遍历，替代递归下降：目录嵌套再深也不会压爆调用栈（修复 RangeError 栈溢出隐患）。
  // 规则链（chain）：某目录含 .gitignore 时读出并解析，追加到链上，只作用于其子树（与 git 语义一致）。
  const queue = [];
  for (const it of items) {
    const e = it.webkitGetAsEntry && it.webkitGetAsEntry();
    if (e) queue.push({ entry: e, prefix: '', chain: [] });
  }
  for (let head = 0; head < queue.length; head++) {
    // 多收集 1 个即可判定超限，无需遍历完整棵「C 盘」——收集阶段只存 File 句柄（惰性，不读内容），上千个也不撑内存
    if (out.length > MAX_DROP_LIMIT) { overflow = true; break; }
    const { entry, prefix, chain } = queue[head];
    if (entry.isFile) {
      // .gitignore 本身照常收集——它是该随工程一起同步的配置文件
      await new Promise(res => entry.file(f => { out.push({ file: f, path: prefix + f.name }); res(); }, () => res()));
    } else if (entry.isDirectory) {
      // .git 目录绝不上传：本地版本库元数据，体积大且对云端毫无意义
      if (entry.name === '.git') continue;
      const reader = entry.createReader();
      const readBatch = () => new Promise(res => reader.readEntries(res, () => res()));
      // 先把本目录的条目读完，再处理其中的 .gitignore（须先于其余子项入队，规则才能对同目录子项生效）
      const pending = [];
      let batch;
      do {
        batch = await readBatch();
        pending.push(...batch);
      } while (batch.length);
      let subChain = chain;
      const giIdx = pending.findIndex(c => c.isFile && c.name === '.gitignore');
      if (giIdx >= 0) {
        const gi = pending.splice(giIdx, 1)[0];
        try {
          const f = await new Promise((res, rej) => gi.file(res, rej));
          const rules = parseGitignore(await f.text());
          if (rules.length) subChain = chain.concat([{ base: prefix + entry.name + '/', rules }]);
        } catch (e) { /* .gitignore 读不出就当没有，不阻断收集 */ }
      }
      const childPrefix = prefix + entry.name + '/';
      for (const child of pending) {
        // 命中忽略规则：文件直接跳过计数；目录不入队（其整棵子树随之排除，与 git 行为一致）
        if (gitignoreMatch(subChain, childPrefix + child.name, child.isDirectory)) { ignored++; continue; }
        queue.push({ entry: child, prefix: childPrefix, chain: subChain });
      }
    }
  }
  if (!out.length) {
    // 非 webkitGetAsEntry 环境（个别 Edge app 模式）的回退：退化为扁平文件列表，同样只受绝对上限约束；
    // 拿不到目录树结构，此路径不支持 .gitignore（如实不支持，非 webkitGetAsEntry 时多数本就无目录概念）
    for (const it of items) {
      if (out.length > MAX_DROP_LIMIT) { overflow = true; break; }
      const f = it.getAsFile && it.getAsFile();
      if (f) out.push({ file: f, path: f.name });
    }
  }
  if (out.length > MAX_DROP_LIMIT) overflow = true;
  // 收集阶段不再截断：返回完整列表，交由调用方决定「确认全部 / 仅前 N 个 / 拒绝」，
  // 否则确认框无法显示真实总数（用户看到的是被砍过的数字，等于变相静默丢弃）。
  return { files: out, overflow, ignored };
}
async function uploadOne(repoFull, path, file, branch, overwrite) {
  const b64 = await fileToB64(file);
  const payload = { message: '上传 ' + path, content: b64, branch: branch };
  if (activeAccount() && activeAccount().platform === 'gitlab') payload.encoding = 'base64';
  try {
    await api('PUT', '/repos/' + repoFull + '/contents/' + encPath(path), payload, { fullName: repoFull }); // 新建由适配层同构改写为 POST
    return { ok: true, created: true };
  } catch (e) {
    // 勾选「覆盖」时：首次创建失败（同名文件已存在）→ 取出云端 sha 后再以「更新」方式重试。
    // 各平台「已存在」状态码不一致（GitHub 422 / GitLab 400 / GitCode 409 …），故不再只认 422，
    // 改为凭「能否取到 sha」判断是否确有同名文件：取到才重试，取不到则回抛原始错误（不掩盖真实失败）。
    if (overwrite) {
      let ex = null;
      try { ex = await api('GET', '/repos/' + repoFull + '/contents/' + encPath(path) + '?ref=' + encodeURIComponent(branch), undefined, { fullName: repoFull }); }
      catch (e2) { ex = null; }
      if (ex && ex.sha) {
        payload.sha = ex.sha;
        await api('PUT', '/repos/' + repoFull + '/contents/' + encPath(path), payload, { fullName: repoFull });
        return { ok: true, updated: true };
      }
    }
    throw e;
  }
}

/* ============ 上传任务面板：任务独立于单例 modal，多任务并存、按提交顺序串行执行 ============
   复盘：旧实现把上传进度 UI 住进 #modal（单例）——上传未完成再拖入新文件，openModal 覆盖旧 DOM，
   旧任务「凭空消失」；且进度刷新用 $('#up-count') 全局实时查询，多任务时互相串台。
   现在：每个任务一张卡片挂在右下角 #upload-dock，节点引用随任务一次性创建并捕获；
   串行队列按提交顺序逐个执行——同一仓库同一分支并发提交会引发平台 SHA 冲突，绝不真并行。 */
let __upTaskSeq = 0;
const __upTasks = []; // { id, state: queued|running|done|aborted, abortRequested, card:{root,stateEl,countEl,linesEl,abortBtn} }
const UP_TASK_STATE_TEXT = { queued: '排队中', running: '上传中', done: '已完成', aborted: '已中止' };
const UploadDock = {
  depth() { return __upTasks.filter(t => t.state === 'queued' || t.state === 'running').length; },
  createTask(title, ahead) {
    const id = ++__upTaskSeq;
    const root = document.createElement('div');
    root.className = 'up-task';
    root.innerHTML =
      '<div class="up-task-head"><span class="up-task-title">' + esc(title) + '</span>' +
      '<span class="up-task-state queued">' + (ahead > 0 ? '排队中（前面还有 ' + ahead + ' 个）' : '排队中') + '</span></div>' +
      '<div class="up-task-body"><div class="up-count"></div><div class="up-lines"></div></div>' +
      '<div class="up-task-actions"><button class="btn">中止上传</button></div>';
    const list = $('#up-dock-list');
    if (list) list.appendChild(root);
    // 新任务加入时展开面板并解除隐藏，确保用户第一时间看到进度（折叠状态可随时点头部切回）
    const dock = $('#upload-dock');
    if (dock) dock.classList.remove('hidden', 'up-collapsed');
    const arrow = $('#up-dock-arrow');
    if (arrow) arrow.textContent = '▲';
    const task = { id, state: 'queued', abortRequested: false, card: {
      root,
      stateEl: root.querySelector('.up-task-state'),
      countEl: root.querySelector('.up-count'),
      linesEl: root.querySelector('.up-lines'),
      abortBtn: root.querySelector('.up-task-actions .btn'),
    } };
    // 中止：请求置位，串行循环在下一个文件边界退出——不强杀在途请求，避免传到一半的半成品更难解读
    task.card.abortBtn.addEventListener('click', () => {
      task.abortRequested = true;
      task.card.abortBtn.disabled = true;
      task.card.abortBtn.textContent = '正在中止…';
    });
    __upTasks.push(task);
    this.updateSummary();
    return task;
  },
  setState(task, state) {
    if (!task) return;
    task.state = state;
    if (task.card.stateEl) {
      task.card.stateEl.className = 'up-task-state ' + state;
      task.card.stateEl.textContent = UP_TASK_STATE_TEXT[state] || state;
    }
    // 任务进入终态后「中止上传」按钮已无意义，隐藏
    if (task.card.abortBtn && (state === 'done' || state === 'aborted')) task.card.abortBtn.classList.add('hidden');
    this.updateSummary();
  },
  setCount(task, done, total) {
    if (task && task.card.countEl) task.card.countEl.textContent = '已完成 ' + done + ' / ' + total;
  },
  setLines(task, html) {
    if (task && task.card.linesEl) {
      task.card.linesEl.innerHTML = html;
      task.card.linesEl.scrollTop = task.card.linesEl.scrollHeight; // 新明细自动滚到底
    }
  },
  // 串行队列：前一任务结束（无论成败）才轮到下一个；链上错误就地吞掉（任务卡片自行呈现状态），不阻断后续任务
  enqueue(run) {
    const p = __upChain.catch(() => {}).then(run);
    __upChain = p.catch(() => {});
    return p;
  },
  updateSummary() {
    const dock = $('#upload-dock');
    if (!dock) return;
    if (!__upTasks.length) { dock.classList.add('hidden'); return; }
    dock.classList.remove('hidden');
    const running = __upTasks.filter(t => t.state === 'running').length;
    const queued = __upTasks.filter(t => t.state === 'queued').length;
    const finished = __upTasks.length - running - queued;
    $('#up-dock-summary').textContent =
      __upTasks.length + ' 个任务' + (running ? ' · ' + running + ' 进行中' : '') +
      (queued ? ' · ' + queued + ' 排队' : '') + (finished ? ' · ' + finished + ' 已结束' : '');
  },
};
let __upChain = Promise.resolve(); // 串行队列链尾（在 UploadDock 定义后紧邻声明，语义内聚）
// 面板头部点击：折叠/展开（折叠后仅留一行摘要，进度不丢）
{
  const head = $('#up-dock-head');
  if (head) head.addEventListener('click', () => {
    const dock = $('#upload-dock');
    if (!dock) return;
    const collapsed = dock.classList.toggle('up-collapsed');
    const arrow = $('#up-dock-arrow');
    if (arrow) arrow.textContent = collapsed ? '▼' : '▲';
  });
}

// meta：null（常规上传），或 { total, kept }（用户选择「仅上传前 kept 个」时的告知信息）
// giSkipped：收集阶段被 .gitignore 跳过的条目数（0/undefined 不显示）——跳过必须让用户看见，否则像静默丢文件
function openUploadModal(files, meta, giSkipped) {
  const branch = state.branch || state.repo.default_branch;
  // ENG-1：弹窗打开时一次性捕获仓库/目录——上传循环内有 await，期间用户可切仓库/切目录，
  // 循环内禁用实时读 state，否则剩余文件会被传到错误仓库/目录（branch 本就是打开时捕获的旧值，语义一致）
  const repoFull = state.repo.full_name;
  const dir = state.path;
  const rows = files.map((f, i) =>
    '<div data-upi="' + i + '">' + esc(f.path) + ' <span style="color:var(--subtle)">(' + Math.ceil(f.file.size / 1024) + ' KB)</span></div>').join('');
  const scopeNote = meta ? '（拖入共 ' + meta.total + ' 个，本次仅上传前 ' + meta.kept + ' 个）' : '';
  const giNote = (giSkipped > 0) ? ' · 已按 .gitignore 跳过 ' + giSkipped + ' 项（编译产物等）' : '';
  openModal(`
    <div class="m-title">上传到 ${esc(repoFull)}</div>
    <p class="m-text">目标目录：${esc(dir || '(根目录)')} · 分支 ${esc(branch)} · 共 ${files.length} 个文件${scopeNote}${giNote}</p>
    <div class="m-list" style="max-height:220px">${rows}</div>
    <label class="m-check"><input type="checkbox" id="up-overwrite"> 覆盖云端同名文件（不勾选时，云端同名文件会上传失败并标红）</label>
    <div class="m-actions">
      <button class="btn" id="up-cancel">取消</button>
      <button class="btn primary" id="up-ok">开始上传</button>
    </div>
  `);
  $('#up-cancel').addEventListener('click', closeModal);
  // 「开始上传」：确认完毕即关弹窗，任务转入右下角上传面板（UploadDock）排队执行。
  // 上传进行中再拖入新文件只会新增一张任务卡片，绝不覆盖/打断既有任务——
  // 旧实现的进度 UI 住进单例 modal，新弹窗一开旧任务 DOM 即被覆盖（任务「消失」），
  // 且 setDone/flush 用 $('#up-count') 全局实时查询导致多任务进度串台，两个问题就此根除。
  $('#up-ok').addEventListener('click', async () => {
    const __ok = $('#up-ok');
    if (__ok.disabled) return; __ok.disabled = true;
    const overwrite = $('#up-overwrite').checked;
    closeModal();
    // 任务卡片的节点引用随任务一次性创建并捕获，进度只写入本任务自己的卡片（不再全局查询）
    const task = UploadDock.createTask(repoFull + (dir ? ' / ' + dir : ''), UploadDock.depth());
    const lines = [];
    const cloudPaths = []; // 记录本轮「已成功落地」的仓库内路径，供上传后校验比对（只校验本次上传的文件）
    const total = files.length;
    const setDone = (n) => UploadDock.setCount(task, n, total);
    const flush = () => UploadDock.setLines(task, lines.join(''));
    // 上传主体：作为串行队列的一个任务执行，按提交顺序逐个跑
    const runTask = async () => {
      UploadDock.setState(task, 'running');
      let okN = 0, limitHits = 0;
      setDone(0);
      for (let i = 0; i < files.length; i++) {
        // 中止请求置位后，在下一个文件边界退出——不强杀在途请求，避免传到一半的半成品更难解读
        if (task.abortRequested) break;
        const f = files[i];
        if (f.file.size > 25 * 1024 * 1024) {
          lines.push('<div class="faill">✗ ' + esc(f.path) + ' — 超过 25MB，跳过</div>');
          flush(); setDone(i + 1);
          continue;
        }
        try {
          // 上传目标只用确认时捕获的 repoFull/dir（ENG-1）；结束后的 loadContents() 仍读实时 state——
          // 用户此时意图是刷新当前视图，语义正确
          const r = await uploadOne(repoFull, (dir ? dir + '/' : '') + f.path, f.file, branch, overwrite);
          okN++;
          cloudPaths.push((dir ? dir + '/' : '') + f.path);
          lines.push('<div class="okl">✓ ' + esc(f.path) + (r.updated ? '（覆盖）' : '') + '</div>');
          limitHits = 0;
        } catch (e) {
          // 403/429 多为平台限流或令牌权限不足：附中文可读提示，避免用户对着错误码无从下手
          let hint = '';
          if (e && e.status === 429) { hint = '（平台限流：请求过于频繁，请稍后再试）'; limitHits++; }
          else if (e && e.status === 403) { hint = '（被平台拒绝：可能触发限流或令牌权限不足）'; limitHits++; }
          // 错误行附 HTTP 状态码：平台 message 措辞（如 "is at X but expected Y"）单看无法定位问题层次
          const httpNote = (e && e.status) ? '（HTTP ' + e.status + '）' : '';
          lines.push('<div class="faill">✗ ' + esc(f.path) + ' — ' + esc(e.message) + httpNote + hint + '</div>');
        }
        flush(); setDone(i + 1);
        // 连续多次限流时继续硬传只会雪上加霜，主动中止，让用户稍后重试剩余文件
        if (limitHits >= 5) {
          lines.push('<div class="faill">⚠ 连续 ' + limitHits + ' 次被平台限流/拒绝，已自动停止本次上传</div>');
          task.abortRequested = true;
        }
      }
      const aborted = task.abortRequested;
      if (!aborted) setDone(files.length);
      // 上传后校验：确认云端实际内容与预期一致。仅当本轮确有文件成功落地时才校验（否则无可比对的目标）
      if (cloudPaths.length) {
        lines.push('<div style="color:var(--subtle)">正在校验云端…</div>'); flush();
        try {
          const v = await verifyUpload(repoFull, branch, cloudPaths);
          if (v.status === 'ok') {
            lines.push('<div class="okl">✅ 校验通过：本次上传的 ' + cloudPaths.length + ' 个文件均已在云端</div>');
          } else if (v.status === 'partial') {
            // 数据不完整：如实标注「未做逐项比对」，绝不报「全部通过」，也绝不判 missing
            lines.push('<div class="faill">⚠ 校验不完整：' + esc(v.note || '云端目录树未完整返回') +
              '，本次未做逐项比对（不排除文件已全部落地）</div>');
          } else if (v.status === 'missing') {
            lines.push('<div class="faill">⚠ 校验未通过：' + v.missing.length + ' 个文件未在云端找到：' + v.missing.map(esc).join('、') + '</div>');
          } else {
            lines.push('<div class="faill">未校验：' + esc(v.reason || '平台不支持上传后校验') + '</div>');
          }
        } catch (e) {
          // 校验请求本身失败（网络/限流/权限）：如实报「未校验」，绝不假装通过
          lines.push('<div class="faill">未校验：' + esc(e.message) + '</div>');
        }
        flush();
      }
      lines.push('<div class="okl">完成：成功 ' + okN + ' / ' + files.length + (aborted ? '（已中止）' : '') + '</div>');
      flush();
      UploadDock.setState(task, aborted ? 'aborted' : 'done');
      toast(aborted ? ('上传已中止：' + okN + ' / ' + files.length) : ('上传完成：' + okN + ' / ' + files.length));
      // 任务结束自动刷新当前视图（旧实现等用户点「完成」按钮，面板化后没有该按钮）
      try { state.file = null; loadContents(); } catch (eFinish) {}
    };
    await UploadDock.enqueue(runTask);
  });
}

// 超量确认框：明确告知真实总数与建议/绝对上限，让用户主动选择，绝不静默截断。
function openUploadConfirm(files, giSkipped) {
  const n = files.length;
  const giNote = (giSkipped > 0) ? '<p class="m-text">已按工程内 .gitignore 跳过 ' + giSkipped + ' 项（编译产物等，详见工程根目录 .gitignore）。</p>' : '';
  openModal(`
    <div class="m-title">确认上传 ${n} 个文件</div>
    <p class="m-text">本次拖入 <b>${n}</b> 个文件，超过建议的单次上限 ${DROP_SUGGEST} 个。逐文件上传会向平台发送 ${n} 次请求，可能触发限流（403/429）而变慢或失败。</p>
    ${giNote}
    <p class="m-text">整体上传上限为 ${MAX_DROP_LIMIT} 个。请选择如何处理（不会静默丢弃任何文件）：</p>
    <label class="m-check"><input type="checkbox" id="uc-remember"> 记住我的选择，下次不再询问（可在「设置 → 拖拽上传」中恢复）</label>
    <div class="m-actions">
      <button class="btn" id="uc-cancel">取消</button>
      <button class="btn" id="uc-part">仅上传前 ${DROP_SUGGEST} 个</button>
      <button class="btn primary" id="uc-all">全部上传（${n} 个）</button>
    </div>
  `);
  const remember = (mode, limit) => { const cb = $('#uc-remember'); if (cb && cb.checked) saveUploadPref(mode, limit); };
  $('#uc-cancel').addEventListener('click', () => { remember('cancel'); closeModal(); toast('已取消本次上传'); });
  $('#uc-part').addEventListener('click', () => {
    remember('first', DROP_SUGGEST);
    closeModal();
    openUploadModal(files.slice(0, DROP_SUGGEST), { total: n, kept: DROP_SUGGEST }, giSkipped);
  });
  $('#uc-all').addEventListener('click', () => { remember('all'); closeModal(); openUploadModal(files, null, giSkipped); });
}

// 上传后校验：比对「本次上传的路径集合」与云端实际存在的路径，返回 ok / missing / partial / skipped 之一。
//   优先 Git Trees API 一次拉全树（caps.treeVerify，仅 github/gitee 成立）；否则逐文件 contents 校验（gitlab/gitcode）。
//   核心不变量：绝不把「数据不完整」当作「数据完整」来判定 missing——
//   树被截断、响应结构异常、或零 blob 条目（语义不明）时，一律返回 partial/skipped，绝不输出「缺失 N 个」。
async function verifyUpload(repoFull, branch, cloudPaths) {
  const acct = activeAccount();
  const cap = (acct && PLATFORMS[acct.platform] && PLATFORMS[acct.platform].caps) || {};
  if (cap.treeVerify) {
    // GET /repos/{o}/{r}/git/trees/{ref}?recursive=1 → { tree:[{path,type,…}], truncated }
    const tree = await api('GET', '/repos/' + repoFull + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1', undefined, { fullName: repoFull });
    // ① 结构异常：拿不到 tree 数组 → 数据不可信，不判 missing
    if (!tree || !Array.isArray(tree.tree)) return { status: 'skipped', reason: '云端目录树响应异常，无法据其校验' };
    // ② 树被截断：比对必然不完整 → 只报「校验不完整」，绝不判 missing
    if (tree.truncated) return { status: 'partial', missing: [], note: '云端目录树被截断（truncated）' };
    // 仅认显式 type==='blob' 的条目为文件；一个都没有（本次确已传文件却零 blob）→ 语义不明，仍不判 missing
    const blobs = new Set(tree.tree.filter(e => e && e.type === 'blob' && e.path).map(e => e.path));
    if (!blobs.size) return { status: 'partial', missing: [], note: '云端目录树未返回任何文件条目，无法据其判定' };
    const missing = cloudPaths.filter(p => !blobs.has(p));
    return { status: missing.length ? 'missing' : 'ok', missing };
  }
  if (cap.contentsVerify !== true) {
    // 无 trees 也无 contents：如实说明「未校验」，不留永远成功的假勾
    return { status: 'skipped', reason: '该平台不支持上传后校验（无 Git Trees / Contents 读接口）' };
  }
  // 逐文件校验（只查本次上传的文件）：200=存在 / 404=确实不存在；非 404 错误冒泡（由调用方按「未校验」提示）。
  // 该路径是「完整信息」——逐文件应答直接给出该文件是否存在，无截断/分页残留，故可据 404 判定 missing。
  const missing = [];
  for (const p of cloudPaths) {
    try {
      await api('GET', '/repos/' + repoFull + '/contents/' + encPath(p) + '?ref=' + encodeURIComponent(branch), undefined, { fullName: repoFull });
    } catch (e) {
      if (e && e.status === 404) missing.push(p);
      else throw e;
    }
  }
  return { status: missing.length ? 'missing' : 'ok', missing };
}
let __dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    __dragDepth++;
    const ov = $('#drop-overlay');
    if (ov) {
      ov.querySelector('.dv').textContent =
        (currentView === 'repo' && state.repo && state.tab === 'files')
          ? '松手上传到 ' + state.repo.full_name + (state.path ? ' / ' + state.path : '')
          : '松手查看上传选项';
      ov.classList.add('on');
    }
  }
});
document.addEventListener('dragleave', () => {
  __dragDepth = Math.max(0, __dragDepth - 1);
  if (!__dragDepth) { const ov = $('#drop-overlay'); if (ov) ov.classList.remove('on'); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  __dragDepth = 0;
  const ov = $('#drop-overlay'); if (ov) ov.classList.remove('on');
  if (!e.dataTransfer) return;
  const { files, overflow, ignored } = await collectDropped(Array.from(e.dataTransfer.items || []));
  if (!files.length) {
    // 一个文件没收到且确有忽略发生：如实说明原因，不让用户以为拖了个空文件夹
    if (ignored > 0) toast('拖入的 ' + ignored + ' 项全部被 .gitignore 规则跳过，没有可上传的文件', 'err');
    return;
  }
  if (!(currentView === 'repo' && state.repo && state.tab === 'files')) {
    toast('请先打开一个仓库的「文件」页，再拖拽上传', 'err');
    return;
  }
  // 超过绝对上限：明确拒绝并说明，绝不静默丢文件（防「误拖整个 C 盘」）
  if (overflow) {
    toast('拖入文件超过单次上限 ' + MAX_DROP_LIMIT + ' 个，已取消；请分批拖入或只拖目标子目录', 'err');
    return;
  }
  // 未超阈值：直接进入上传弹窗，不打扰
  if (files.length <= DROP_SUGGEST) { openUploadModal(files, null, ignored); return; }
  // 超过建议阈值：先看用户是否已「记住选择」，未记住才弹确认框
  const pref = loadUploadPref();
  if (pref && pref.mode === 'all') { openUploadModal(files, null, ignored); return; }
  if (pref && pref.mode === 'first') {
    const m = Math.min(pref.limit, files.length);
    openUploadModal(files.slice(0, m), { total: files.length, kept: m }, ignored);
    return;
  }
  if (pref && pref.mode === 'cancel') {
    toast('已按你记住的选择取消上传；可在「设置 → 拖拽上传」中恢复询问', 'err');
    return;
  }
  openUploadConfirm(files, ignored);
});

/* ================= Ctrl+K 命令面板 ================= */
function openPalette(){
  const nav = [
    ['总览', 'overview'], ['我的仓库', 'repos'], ['我的收藏', 'stars'],
    ['通知', 'notifications'], ['搜索仓库', 'search'], ['代码片段', 'gists'], ['设置', 'settings'],
  ];
  const actions = [
    ['切换明暗主题', () => toggleTheme()],
    ['新建仓库', () => openCreateRepo()],
    ['账号绑定管理', () => showView('settings')],
  ];
  const buildItems = (q) => {
    q = (q || '').trim().toLowerCase();
    const out = [];
    if (q) {
      state.repos.filter(r => r.full_name.toLowerCase().includes(q)).slice(0, 8)
        .forEach(r => out.push(['打开仓库 ' + r.full_name, () => openRepo(r.full_name)]));
    }
    nav.concat(actions).forEach(c => { if (!q || c[0].toLowerCase().includes(q)) out.push(c); });
    return out;
  };
  openModal(`
    <div class="m-title">命令面板</div>
    <input class="m-input" id="kp-input" placeholder="输入命令或仓库名过滤（Enter 执行第一条，Esc 关闭）" autocomplete="off">
    <div class="m-list" id="kp-list" style="max-height:320px;margin-top:12px"></div>
  `);
  let current = [];
  const renderList = (q) => {
    current = buildItems(q);
    $('#kp-list').innerHTML = current.length
      ? current.map((c, i) => '<div class="acct" data-kpi="' + i + '">' + esc(c[0]) + '</div>').join('')
      : '<div class="acct" style="color:var(--muted)">没有匹配项</div>';
    $$('#kp-list .acct').forEach(el => el.addEventListener('click', () => {
      closeModal();
      current[Number(el.dataset.kpi)][1]();
    }));
  };
  renderList('');
  const inp = $('#kp-input');
  inp.focus();
  inp.addEventListener('input', () => renderList(inp.value));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && current.length) { const c = current[0]; closeModal(); c[1](); }
    if (e.key === 'Escape') closeModal();
  });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (state.user) openPalette();
  }
});

/* ---------------- 启动 ---------------- */
state.theme = localStorage.getItem('ghc_theme') || 'light';
applyTheme();
loadAccounts().then(() => {
  renderLoginPlatforms();
  if (activeAccount()) enterShell();
  else { $('#view-login').classList.remove('hidden'); loginPing(); }
});

/* ===== 事件委托分发器（替代内联 onclick，配合 CSP script-src 'self'） ===== */
(function () {
  var ACTIONS = {
    loadRepos: function () { loadRepos(); },
    openCreateRepo: function () { openCreateRepo(); },
    selectAllVisible: function () { selectAllVisible(); },
    clearSelection: function () { clearSelection(); },
    batchDelete: function () { batchDelete(); },
    closeModal: function () { closeModal(); },
    showView: function (arg) { showView(arg); },
    loadStars: function () { loadStars(); },
    markAllRead: function () { markAllRead(); },
    loadNotifications: function () { loadNotifications(); },
    openNewGist: function () { openNewGist(); },
    loadGists: function () { loadGists(); },
    toggleTheme: function () { toggleTheme(); },
    showViewBack: function () { showView(currentViewBack()); },
    loadContents: function () { loadContents(); },
    openNewIssue: function () { openNewIssue(); }
  };
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var h = ACTIONS[el.getAttribute('data-act')];
    if (h) h(el.getAttribute('data-arg'));
  });
})();
