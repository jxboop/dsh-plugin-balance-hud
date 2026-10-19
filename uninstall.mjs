#!/usr/bin/env node
/**
 * dsh-plugin-balance-hud 卸载脚本。
 *
 *   node uninstall.mjs                 # 移除链接 + bundles 注册（保留插件目录）
 *   node uninstall.mjs --purge         # 连插件目录一起删
 *   node uninstall.mjs --profile web   # 指定 profile
 *   node uninstall.mjs --dsh-home D:\x # 自定义 DSH 主目录
 *
 * 只撤销本插件造成的东西：profile/node_modules 下的链接、package.json 里的
 * bundles 条目。插件目录默认保留，方便你回滚或再次安装。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = "dsh-plugin-balance-hud";

function parseArgs(argv) {
  const out = { profile: "web", dshHome: "", profileDir: "", purge: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--dsh-home") out.dshHome = argv[++i];
    else if (a === "--profile-dir") out.profileDir = argv[++i];
    else if (a === "--purge") out.purge = true;
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dshHome = args.dshHome
  ? path.resolve(args.dshHome)
  : process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), ".dsh");
const profileDir = args.profileDir
  ? path.resolve(args.profileDir)
  : path.join(dshHome, "profiles", args.profile);
const pluginDir = path.join(dshHome, "plugin-src", PKG);
const linkPath = path.join(profileDir, "node_modules", PKG);

console.log(`profile : ${profileDir}`);

// 1. 移除链接（只删链接，不删真实目录）
try {
  const stat = fs.lstatSync(linkPath);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(linkPath);
    console.log(`✅ 已移除链接: ${linkPath}`);
  } else {
    console.log(`⚠️  ${linkPath} 是真实目录，不是本脚本建的链接，跳过`);
  }
} catch {
  console.log(`  链接不存在，跳过: ${linkPath}`);
}

// 2. 从 bundles 移除
const profilePkgPath = path.join(profileDir, "package.json");
if (fs.existsSync(profilePkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(profilePkgPath, "utf8"));
  const bundles = pkg?.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes(PKG)) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PKG);
    fs.writeFileSync(profilePkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    console.log(`✅ 已从 bundles 移除: ${PKG}`);
  } else {
    console.log(`  bundles 里没有它，跳过`);
  }
}

// 3. 可选：删插件目录
if (args.purge) {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  console.log(`✅ 已删除插件目录: ${pluginDir}`);
} else {
  console.log(`  插件目录保留: ${pluginDir}（加 --purge 可一并删除）`);
}

console.log(`\n重启 dsh web 后生效。`);
