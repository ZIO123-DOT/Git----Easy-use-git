// 打包 Git 控制台 Pro 便携版（跨平台）。
// 用法：
//   node build-desktop.mjs                                   # 当前平台/架构
//   node build-desktop.mjs --platform=darwin --arch=arm64    # Apple Silicon
//   node build-desktop.mjs --platform=darwin --arch=x64      # Intel Mac
//   node build-desktop.mjs --platform=win32 --arch=x64       # Windows（兼容旧流程）
//   node build-desktop.mjs --electron-version=44.3.0
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const APP_NAME = "Git 控制台";
const OUT_DIR = path.join(here, "release");

function cliArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}
const platform = cliArg("platform", process.platform);
const arch = cliArg("arch", process.arch === "arm64" ? "arm64" : "x64");
const electronVersion = cliArg("electron-version", "44.3.0");

// 解析 @electron/packager：优先本地 node_modules（跨平台、CI 可用），
// 回退到 Windows 旧流程的 deepseek-harness（零下载复用其 electron 与缓存）。
async function loadPackager() {
  try {
    const m = await import("@electron/packager");
    return m.packager || m.default?.packager || m.default || m;
  } catch {
    const HARNESS = "D:/win/ChatGPT/电赛/deepseek-harness";
    try {
      const theirRequire = createRequire(path.join(HARNESS, "package.json"));
      const pkgModule = theirRequire("@electron/packager");
      return pkgModule.packager || pkgModule.default?.packager;
    } catch {
      console.error(
        "缺少 @electron/packager。请先在 electron-app 目录执行：npm install -D @electron/packager\n" +
          "（或确认 Windows 上 deepseek-harness 路径存在）",
      );
      process.exit(1);
    }
  }
}
const packager = await loadPackager();

// Windows：优先复用 harness 缓存里的 electron zip，避免重复下载
let electronZipDir;
if (platform === "win32") {
  const cacheRoot = path.resolve("D:/win/ChatGPT/电赛/deepseek-harness", ".npm-cache/electron");
  try {
    for (const entry of await fs.readdir(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = await fs.readdir(path.join(cacheRoot, entry.name));
      if (files.some((f) => /^electron-v.+-win32-x64\.zip$/.test(f))) {
        electronZipDir = path.join(cacheRoot, entry.name);
        break;
      }
    }
  } catch {}
}

const TARGET_DIR = path.resolve(OUT_DIR, `${APP_NAME}-${platform}-${arch}`);

// 保留用户数据（代理配置等）：打包会删掉目标目录
const KEEP_DIR = path.resolve(here, ".build-keep");
const PRESERVE = [".app-data"];
try {
  await fs.mkdir(KEEP_DIR, { recursive: true });
  for (const name of PRESERVE) {
    const from = path.join(TARGET_DIR, name);
    try { await fs.rename(from, path.join(KEEP_DIR, name)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
} catch {}
await fs.rm(TARGET_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });

// 图标：Windows 用 .ico；mac 用 .icns（缺省时用 Electron 默认图标）
let icon;
if (platform === "win32") {
  icon = path.resolve(here, "build", "icon.ico");
} else {
  const icns = path.resolve(here, "build", "icon.icns");
  try { await fs.access(icns); icon = icns; } catch {}
}

const output = await packager({
  dir: here,
  name: APP_NAME,
  out: OUT_DIR,
  platform,
  arch,
  overwrite: true,
  asar: false,
  prune: true,
  electronVersion,
  ...(icon ? { icon } : {}),
  ...(electronZipDir ? { electronZipDir } : {}),
  ...(platform === "win32"
    ? {
        win32metadata: {
          CompanyName: "Personal local project",
          FileDescription: "本地多平台 Git 管理台",
          ProductName: APP_NAME,
        },
      }
    : {}),
  ignore: [
    /^\/release(\/|$)/,
    /^\/\.build-keep(\/|$)/,
    /^\/\.audit(\/|$)/,
    /^\/main\.log$/,
    /^\/main\.old\.log$/,
    /^\/tests(\/|$)/,
    /^\/build-desktop\.mjs$/,
    /^\/\.app-data(\/|$)/,
  ],
});
const releaseRoot = path.resolve(output[0]);
for (const name of PRESERVE) {
  const from = path.join(KEEP_DIR, name);
  try { await fs.rename(from, path.join(releaseRoot, name)); } catch (e) { if (e.code !== "ENOENT") throw e; }
}
await fs.rm(KEEP_DIR, { recursive: true, force: true }).catch(() => {});
console.log(releaseRoot);
