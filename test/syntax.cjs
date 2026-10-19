/**
 * Syntax check for the balance-hud package halves.
 *
 * Reads each file as UTF-8 and compiles it as an ES module via
 * vm.SourceTextModule — a real parse, with no execution and no console
 * encoding in the way. Run with: node --experimental-vm-modules test/syntax.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const targets = ["lib/index.js", "lib/client.js"];
let failed = false;

for (const relative of targets) {
	const file = path.join(__dirname, "..", relative);
	const text = fs.readFileSync(file, "utf8");

	// Round-trip guard: what we read must be valid UTF-8 that re-encodes identically.
	if (!Buffer.from(text, "utf8").equals(fs.readFileSync(file))) {
		console.error("FAIL " + relative + ": file is not valid UTF-8");
		failed = true;
		continue;
	}

	// Report the interesting non-ASCII presence so an encoding slip is visible.
	const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
	const replacement = (text.match(/\ufffd/g) ?? []).length;

	try {
		new vm.SourceTextModule(text, { identifier: file });
		console.log("ok   " + relative.padEnd(14) + " cjk=" + cjk + " replacement-chars=" + replacement);
	} catch (error) {
		console.error("FAIL " + relative + ": " + error.message);
		failed = true;
	}

	if (replacement > 0) {
		console.error("FAIL " + relative + ": contains U+FFFD replacement characters");
		failed = true;
	}
}

process.exit(failed ? 1 : 0);
