// .gitignore 拖拽上传支持 回归测试（零依赖，直接从 console.html 提取真实源码验证）
// 运行：node tests/gitignore-upload.test.mjs
// 覆盖：
//   [MUT]  parseGitignore/gitignoreMatch 纯函数行为（运行真实源码）
//   [STRUCT] collectDropped 遍历集成（规则链 / .git 跳过 / ignored 如实回传）与调用链透传
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.AUDIT_TARGET
  ? (path.isAbsolute(process.env.AUDIT_TARGET) ? process.env.AUDIT_TARGET : path.resolve(here, "..", process.env.AUDIT_TARGET))
  : path.resolve(here, "..");
const html = fs.readFileSync(path.join(target, "console.js"), "utf8");

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

// 真实源码 → 可执行函数（parseGitignore 设计为自包含，无外部依赖）
const parseGitignore = eval("(function(){" + extractFn(html, "function parseGitignore(") + "; return parseGitignore; })()");
const gitignoreMatch = eval("(function(){" + extractFn(html, "function gitignoreMatch(") + "; return gitignoreMatch; })()");
const srcCollect = extractFn(html, "async function collectDropped(");

let pass = 0, fail = 0;
const check = (name, cond, detail = "", struct = false) => {
  const tag = struct ? "[STRUCT]" : "[MUT]";
  if (cond) { pass++; console.log("PASS", tag, name); }
  else { fail++; console.error("FAIL", tag, name, "->", detail); }
};

/* ============ parseGitignore / gitignoreMatch：运行时行为 ============ */
{
  // 真实场景：用户工程 .gitignore 的核心规则（Keil MDK 编译产物）
  const rules = parseGitignore("*.o\n*.d\n*.crf\n*.lst\n*.dep\n*.axf\n*.iex\n*.lnp\n*.map\n*.htm\n*.bak\n*.uvguix.*\nJLinkLog.txt\nListings/\nObjects/\n");
  const mk = (ruleSets) => ruleSets.map(([base, text]) => ({ base, rules: parseGitignore(text) }));
  const hit = (chain, p, isDir = false) => gitignoreMatch(chain, p, isDir);
  const C = (base, text) => mk([[base, text]]);

  check("[运行时] 编译产物扩展名（.o/.d/.crf/.map 等）在任意深度命中",
    ["储球圆盘(测过)/MDK-ARM/storage_disc/stm32f1xx_hal.o", "a/b/x.d", "y.crf", "out/z.map"].every(p => hit(C("", "*.o\n*.d\n*.crf\n*.map"), p))
    && !hit(C("", "*.o"), "src/main.c") && !hit(C("", "*.o"), "a/b/note.onote") && !hit(C("", "*.o"), "a/b/obj.c"),
    "");
  check("[运行时] 目录规则 Objects/ 仅命中目录，不误伤同名文件",
    hit(C("", "Objects/"), "MDK-ARM/Objects", true) && !hit(C("", "Objects/"), "MDK-ARM/Objects.txt") && !hit(C("", "Objects/"), "MDK-ARM/Objects"),
    "");
  check("[运行时] 取反规则后匹配优先（*.o 忽略，!keep.o 挽回）",
    (() => {
      const c = C("", "*.o\n!keep.o");
      return hit(c, "a/stm32.o") && !hit(c, "keep.o") && !hit(c, "sub/keep.o");
    })(),
    "");
  check("[运行时] 锚定规则 /top.txt 仅根层生效；含 / 的模式相对规则目录锚定",
    hit(C("", "/top.txt"), "top.txt") && !hit(C("", "/top.txt"), "sub/top.txt")
    && hit(C("", "MDK/storage_disc/"), "MDK/storage_disc/x", true) && !hit(C("", "MDK/storage_disc/"), "other/storage_disc/x", true),
    "");
  check("[运行时] ** 跨段：**/temp/*.d 命中任意深度 temp 目录下的 .d；结尾 a/** 命中其下全部",
    (() => {
      const c = C("", "**/temp/*.d");
      const c2 = C("", "a/**");
      return hit(c, "MDK/temp/x.d") && hit(c, "p/q/temp/x.d") && hit(c, "temp/x.d")
        && !hit(c, "MDK/temp/x.d.bak") && !hit(c, "MDK/temp/sub/x.d")
        && hit(c2, "a/x") && hit(c2, "a/x/y/z.o") && !hit(c2, "ab/x");
    })(),
    "");
  check("[运行时] 注释与空行不产生规则；括号等正则元字符按字面处理",
    (() => {
      const rules0 = parseGitignore("# 注释行\n\n   \n*.o\n");
      const c = C("", "build(测)/\n");
      return rules0.length === 1
        && hit(c, "build(测)/x", true) && !hit(c, "build测/x", true);
    })(),
    "");
  check("[运行时] 规则链：深层 .gitignore 覆盖浅层（子目录 !keep.o 挽回浅层 *.o）",
    (() => {
      const chain = [
        { base: "", rules: parseGitignore("*.o") },
        { base: "MDK-ARM/", rules: parseGitignore("!keep.o") },
      ];
      return gitignoreMatch(chain, "MDK-ARM/keep.o") === false
        && gitignoreMatch(chain, "MDK-ARM/other.o") === true
        && gitignoreMatch(chain, "Drivers/x.o") === true;
    })(),
    "");
  check("[运行时] 规则只作用于其子树（base 之外的路径不被规则误伤——回归抓过的 slice 错位真 bug）",
    (() => {
      const chain = [{ base: "储球圆盘(测过)/", rules: parseGitignore("*.o") }];
      return gitignoreMatch(chain, "储球圆盘(测过)/MDK/x.o") === true
        && gitignoreMatch(chain, "其他工程/MDK/x.o") === false
        && gitignoreMatch(chain, "x.o") === false;
    })(),
    "");
}

/* ============ collectDropped / 调用链：结构断言 ============ */
{
  check("[STRUCT] collectDropped 遍历时跳过 .git 目录（版本库元数据绝不上传）",
    /entry\.name === '\.git'/.test(srcCollect), "");
  check("[STRUCT] collectDropped 读各目录 .gitignore 并构造规则链（base 锚定其子树）",
    /c\.name === '\.gitignore'/.test(srcCollect) && /parseGitignore\(await f\.text\(\)\)/.test(srcCollect)
    && /subChain = chain\.concat\(\[\{ base: prefix \+ entry\.name \+ '\/', rules \}\]\)/.test(srcCollect), "");
  check("[STRUCT] collectDropped 如实回传 ignored（跳过必须让用户看见，绝不静默）",
    /let ignored = 0;/.test(srcCollect) && /return \{ files: out, overflow, ignored \}/.test(srcCollect)
    && /gitignoreMatch\(subChain, childPrefix \+ child\.name, child\.isDirectory\)/.test(srcCollect), "");
  check("[STRUCT] 忽略数透传到确认弹窗（openUploadModal 第三参 / openUploadConfirm 第二参）",
    /function openUploadModal\(files, meta, giSkipped\)/.test(html)
    && /function openUploadConfirm\(files, giSkipped\)/.test(html)
    && /openUploadConfirm\(files, ignored\)/.test(html)
    && /已按 \.gitignore 跳过 ' \+ giSkipped \+ ' 项/.test(html), "");
  check("[STRUCT] 全部被忽略时给出明确反馈（不表现为「拖了个空文件夹」）",
    /全部被 \.gitignore 规则跳过/.test(html), "");
}

console.log("\n---- 结果: " + pass + " PASS / " + fail + " FAIL ----");
process.exit(fail ? 1 : 0);
