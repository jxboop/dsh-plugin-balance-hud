/**
 * Package-contract check for the balance-hud plugin.
 *
 * Confirms the three things the host Loader and the web client-modules scanner
 * need: the package declares `dsh.client`, that declaration resolves to an
 * existing `exports["./client"]` bundle, and the bundle is a real
 * `__ModuleLoader__` registration exporting `apply` plus an inject list.
 *
 * Run with: node test/contract.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

console.log("package           : " + pkg.name);
console.log("dsh.client        : " + JSON.stringify(pkg.dsh.client));
console.log("exports ./client  : " + JSON.stringify(pkg.exports["./client"]));

// The scanner requires a `dsh.client` declaration carrying a platform.
assert.ok(pkg.dsh !== undefined && pkg.dsh.client !== undefined, "package declares no dsh.client");
assert.strictEqual(typeof pkg.dsh.client.platform, "string", "dsh.client.platform must be a string");

// ...and it requires exports["./client"] to resolve to the bundle.
const rel = pkg.exports["./client"].default;
assert.strictEqual(typeof rel, "string", "exports['./client'] must resolve to a path");
const bundlePath = path.join(root, rel);
assert.ok(fs.existsSync(bundlePath), "client bundle missing: " + bundlePath);

// The bundle patch the profile loader applies.
const patch = pkg.dsh.bundle.patch;
const patchPath = path.join(root, patch);
assert.ok(fs.existsSync(patchPath), "bundle patch missing: " + patch);

// The row MUST declare webServer. Without it the row can activate before the web
// carrier exists, register no route, and leave the badge showing "signal lost" —
// which is exactly the failure this declaration fixes.
const patchText = fs.readFileSync(patchPath, "utf8");
assert.ok(/id:\s*balance-hud/.test(patchText), "patch does not insert the balance-hud row");
assert.ok(/name:\s*dsh-plugin-balance-hud/.test(patchText), "patch row names the wrong package");
assert.ok(
	/inject:\s*\[[^\]]*\bwebServer\b[^\]]*\]/.test(patchText),
	"patch row must declare `inject: [webServer]`"
);
console.log("patch inject      : [webServer] (required: the carrier may not be live at activation)");

const source = fs.readFileSync(bundlePath, "utf8");
assert.ok(source.includes("window.__ModuleLoader__.load"), "bundle is not a module registration");
assert.ok(source.includes('id: "' + pkg.name + '"'), "bundle id does not match the package name");
assert.ok(/exports\.apply = apply/.test(source), "bundle exports no apply()");
assert.ok(/exports\.inject = inject/.test(source), "bundle exports no inject");

const inject = source.match(/const inject = \[([^\]]*)\]/);
assert.ok(inject !== null, "bundle declares no inject list");
const names = inject[1]
	.split(",")
	.map((value) => value.trim().replace(/^"|"$/g, ""))
	.filter((value) => value.length > 0);
console.log("bundle inject     : " + JSON.stringify(names));
assert.ok(names.includes("slots"), "bundle must inject the slot service");
assert.ok(names.includes("timer"), "bundle must inject the timer service");

// The host half must actually be a module exporting apply.
const host = fs.readFileSync(path.join(root, "lib", "index.js"), "utf8");
assert.ok(/export function apply/.test(host), "host half exports no apply()");

console.log("\nOK: dsh.client declaration, exports['./client'], bundle registration, and the");
console.log("    bundle patch are all present and mutually consistent.");
