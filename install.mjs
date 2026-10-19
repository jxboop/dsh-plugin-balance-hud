#!/usr/bin/env node
/**
 * dsh-plugin-balance-hud 安装脚本（跨平台，无需第三方依赖）。
 *
 *   node install.mjs                     # 从 GitHub 安装
 *   node install.mjs --profile web       # 指定 profile（默认 web）
 *   node install.mjs --source ./本地目录  # 从本地目录安装（开发用）
 *   node install.mjs --dsh-home D:\x     # 自定义 DSH 主目录
 *
 * 做四件事，全部幂等：
 *   1. 把插件包放到 <dsh-home>/plugin-src/dsh-plugin-balance-hud
 *   2. 在 <profile>/node_modules 里建链接（Windows 用 junction，无需管理员）
 *   3. 把包名写进 <profile>/package.json 的 dsh.profile.bundles
 *   4. 打印重启指引
 *
 * 设计原则：只改 profile 的 package.json 里 bundles 这一个字段，其余内容原样保留。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = "dsh-plugin-balance-hud";
const REPO = "https://github.com/jxboop/dsh-plugin-balance-hud.git";

// ── 参数 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { profile: "web", dshHome: "", source: REPO, profileDir: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--dsh-home") out.dshHome = argv[++i];
    else if (a === "--source") out.source = argv[++i];
    else if (a === "--profile-dir") out.profileDir = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法: node install.mjs [选项]

  --profile <名字>     DSH profile（默认 web）
  --dsh-home <目录>    DSH 主目录（默认取 $DSH_HOME，否则 ~/.dsh）
  --profile-dir <目录> 直接指定 profile 目录（优先级最高）
  --source <路径|URL>  插件来源（默认 GitHub 仓库）`);
  process.exit(0);
}

// ── 定位 DSH 目录 ───────────────────────────────────────────────────────
function resolveDshHome() {
  if (args.dshHome) return path.resolve(args.dshHome);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(os.homedir(), ".dsh");
}

const dshHome = resolveDshHome();
const pluginDir = path.join(dshHome, "plugin-src", PKG);
const profileDir = args.profileDir
  ? path.resolve(args.profileDir)
  : path.join(dshHome, "profiles", args.profile);

function fail(message, hint) {
  console.error(`\n❌ ${message}`);
  if (hint) console.error(`   ${hint}`);
  process.exit(1);
}

if (!fs.existsSync(profileDir)) {
  fail(
    `找不到 profile 目录: ${profileDir}`,
    "先用 `dsh web` 启动过一次以生成 profile，或用 --profile / --profile-dir 指定。",
  );
}
const profilePkgPath = path.join(profileDir, "package.json");
if (!fs.existsSync(profilePkgPath)) {
  fail(`profile 里没有 package.json: ${profilePkgPath}`);
}

console.log(`DSH 主目录 : ${dshHome}`);
console.log(`profile    : ${profileDir}`);
console.log(`插件目录   : ${pluginDir}`);

// ── 1. 取插件源码 ───────────────────────────────────────────────────────
const isUrl = /^(https?:\/\/|git@|github:|git\+)/.test(args.source);
fs.mkdirSync(path.dirname(pluginDir), { recursive: true });

if (isUrl) {
  const existing = fs.existsSync(path.join(pluginDir, ".git"));
  if (existing) {
    console.log("\n[1/4] 更新已有仓库…");
    const pull = spawnSync("git", ["-C", pluginDir, "pull", "--ff-only"], { stdio: "inherit" });
    if (pull.status !== 0) fail("git pull 失败", "可删掉插件目录后重试。");
  } else {
    if (fs.existsSync(pluginDir)) {
      fail(
        `插件目录已存在但不是 git 仓库: ${pluginDir}`,
        "确认里面没有你要保留的东西后删掉它，再重新运行。",
      );
    }
    console.log("\n[1/4] 克隆仓库…");
    const clone = spawnSync("git", ["clone", "--depth", "1", args.source, pluginDir], { stdio: "inherit" });
    if (clone.status !== 0) fail("git clone 失败", "确认已安装 git 且能访问 GitHub。");
  }
} else {
  const src = path.resolve(args.source);
  if (!fs.existsSync(path.join(src, "package.json"))) {
    fail(`本地来源不是插件包: ${src}`, "该目录里应当有 package.json。");
  }
  console.log("\n[1/4] 复制本地目录…");
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.cpSync(src, pluginDir, {
    recursive: true,
    filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p),
  });
}

if (!fs.existsSync(path.join(pluginDir, "lib", "client.js"))) {
  fail("插件包不完整：缺少 lib/client.js");
}
if (!fs.existsSync(path.join(pluginDir, "cordis.patch.yml"))) {
  fail("插件包不完整：缺少 cordis.patch.yml");
}

// ── 2. 链接进 profile 的 node_modules ───────────────────────────────────
const linkPath = path.join(profileDir, "node_modules", PKG);
fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });

let existingState = "absent";
try {
  const stat = fs.lstatSync(linkPath);
  existingState = stat.isSymbolicLink() ? "link" : "real";
} catch {
  existingState = "absent";
}

if (existingState === "real") {
  fail(
    `已存在同名真实目录（不是链接）: ${linkPath}`,
    "如果你之前手动复制装过，先删掉它再运行，避免装了两份。",
  );
}
if (existingState === "link") {
  fs.unlinkSync(linkPath);
}
console.log(`\n[2/4] 建立链接 → ${linkPath}`);
fs.symlinkSync(pluginDir, linkPath, process.platform === "win32" ? "junction" : "dir");

if (!fs.existsSync(path.join(linkPath, "lib", "client.js"))) {
  fail("链接建立后仍读不到 lib/client.js", "可能是权限问题。");
}

// ── 3. 写进 dsh.profile.bundles ─────────────────────────────────────────
console.log("\n[3/4] 注册到 profile 的 bundles…");
const raw = fs.readFileSync(profilePkgPath, "utf8");
let pkg;
try {
  pkg = JSON.parse(raw);
} catch (error) {
  fail(`profile 的 package.json 不是合法 JSON: ${error.message}`);
}

pkg.dsh ??= {};
pkg.dsh.profile ??= {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
if (bundles.includes(PKG)) {
  console.log(`  已经注册过，跳过`);
} else {
  bundles.push(PKG);
  pkg.dsh.profile.bundles = bundles;
  fs.writeFileSync(profilePkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log(`  已加入: ${PKG}`);
}

// ── 4. 指引 ─────────────────────────────────────────────────────────────
console.log("\n[4/4] 完成");
console.log(`
✅ ${PKG} 已安装

下一步：
  1. 重启 DSH：Ctrl+C 停掉 dsh web，再执行 dsh web
  2. 浏览器 Ctrl+Shift+R 硬刷新

徽章位置：右下角（小舞桌宠上方）。没有小舞的话会留一段空档，
想贴到更下面，把 lib/client.js 里 [data-bh-root] 的 bottom: 138px 改小即可。

凭据：插件读取 DEEPSEEK_API_KEY，来源依次是
  环境变量 → DSH 凭据服务 → $DSH_HOME/.credentials.yaml
`);
