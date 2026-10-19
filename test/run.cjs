/**
 * Run every balance-hud check in order and report a single verdict.
 *
 *   node test/run.cjs
 *
 * Each child is a standalone harness, so a failure names the stage that broke
 * instead of stopping at the first assertion.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const checks = [
	["syntax", ["--experimental-vm-modules", "test/syntax.cjs"], "both halves parse as ES modules and are valid UTF-8"],
	["contract", ["test/contract.cjs"], "dsh.client, exports['./client'] and the bundle patch agree"],
	["host", ["test/host-harness.cjs"], "the node half serves the route and never leaks the key"],
	["client", ["test/harness.cjs"], "the browser half mounts, polls, and derives every state"],
	["gestures", ["test/gestures.cjs"], "the badge drags, clamps, persists, auto-tucks into any edge"],
];

let failed = 0;
for (const [name, args, purpose] of checks) {
	const result = spawnSync(process.execPath, args, { cwd: path.join(__dirname, ".."), encoding: "utf8" });
	const ok = result.status === 0;
	if (!ok) failed += 1;
	console.log((ok ? "PASS  " : "FAIL  ") + name.padEnd(9) + " " + purpose);
	if (!ok) {
		const output = (result.stdout || "") + (result.stderr || "");
		console.log(
			output
				.split(/\r?\n/)
				.filter((line) => line.trim().length > 0)
				.map((line) => "        " + line)
				.join("\n")
		);
	}
}

console.log("");
if (failed === 0) console.log("All " + checks.length + " checks passed.");
else console.log(failed + " of " + checks.length + " checks FAILED.");
process.exit(failed === 0 ? 0 : 1);
