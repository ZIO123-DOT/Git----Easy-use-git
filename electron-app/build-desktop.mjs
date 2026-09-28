// 打包 GitHub 控制台 Pro 便携版（复用 deepseek-harness 的 electron 与缓存，零下载）
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = "D:/win/ChatGPT/电赛/deepseek-harness";

const theirRequire = createRequire(path.join(HARNESS, "package.json"));
const pkgModule = theirRequire("@electron/packager");
const packager = pkgModule.packager || pkgModule.default?.packager;

const APP_NAME = "Git 控制台";
const OUT_DIR = path.join(here, "release");
const TARGET_DIR = path.resolve(OUT_DIR, `${APP_NAME}-win32-x64`);

const cacheRoot = path.resolve(HARNESS, ".npm-cache/electron");
let electronZipDir;
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

const output = await packager({
  dir: here,
  name: APP_NAME,
  out: OUT_DIR,
  platform: "win32",
  arch: "x64",
  overwrite: true,
  asar: false,
  prune: true,
  electronVersion: "44.3.0",
  icon: path.resolve(here, "build", "icon.ico"),
  ...(electronZipDir ? { electronZipDir } : { download: { cacheRoot } }),
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
  win32metadata: {
    CompanyName: "Personal local project",
    FileDescription: "本地多平台 Git 管理台",
    ProductName: APP_NAME,
  },
});
const releaseRoot = path.resolve(output[0]);
for (const name of PRESERVE) {
  const from = path.join(KEEP_DIR, name);
  try { await fs.rename(from, path.join(releaseRoot, name)); } catch (e) { if (e.code !== "ENOENT") throw e; }
}
await fs.rm(KEEP_DIR, { recursive: true, force: true }).catch(() => {});
console.log(releaseRoot);
