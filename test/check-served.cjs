/**
 * Confirm the RUNNING web instance serves the current, valid client bundle.
 *
 *   node test/check-served.cjs [base-url]
 *
 * Reads the boot graph out of `/`, finds this package's bundle URL, fetches it,
 * and asserts the body is the authored lib/client.js and carries the current
 * bottom-right anchor. This is the check that separates "the file on disk is
 * fixed" from "the browser would actually receive the fixed file".
 *
 * The dev fence may answer 401 without a bootstrap token; that is reported as
 * "fence" rather than a failure of the bundle.
 */
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN = "dsh-plugin-balance-hud";
const base = process.argv[2] ?? "http://127.0.0.1:3080";
const token = process.argv[3];

/** Pull the `globalThis["__DSH_BOOT__"] = {...}` literal out of the index. */
function bootGraphOf(html) {
	const marker = html.indexOf('__DSH_BOOT__"]');
	if (marker < 0) return null;
	const start = html.indexOf("{", marker);
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < html.length; i += 1) {
		const ch = html[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return JSON.parse(html.slice(start, i + 1));
		}
	}
	return null;
}

(async () => {
	let cookie = "";
	if (token !== undefined) {
		const bootstrap = await fetch(base + "/?token=" + token, { redirect: "manual" });
		const raw = typeof bootstrap.headers.getSetCookie === "function" ? bootstrap.headers.getSetCookie() : [];
		cookie = raw.map((v) => v.split(";")[0]).join("; ");
	}

	const index = await fetch(base + "/", { headers: cookie ? { cookie } : {} });
	console.log("index            : " + index.status);
	if (index.status === 401) {
		console.log("fence active     : pass a bootstrap token to read the boot graph");
		console.log("                   (a 401 here says nothing about the bundle)");
		return;
	}
	const html = await index.text();
	const boot = bootGraphOf(html);
	if (boot === null) throw new Error("no boot graph in the served index");
	const row = (boot.entries ?? []).find((entry) => entry.id === PLUGIN);
	if (row === undefined) throw new Error(PLUGIN + " is ABSENT from the boot graph");
	console.log("boot row         : " + row.id);
	console.log("boot url         : " + row.url);

	const bundle = await fetch(base + row.url, { headers: cookie ? { cookie } : {} });
	console.log("bundle response  : " + bundle.status + " " + bundle.headers.get("content-type"));
	if (!bundle.ok) throw new Error("bundle fetch failed with " + bundle.status);
	const served = await bundle.text();

	// Parsing the served text is the real test: the broken version failed here.
	try {
		new Function("window", "document", "console", served);
		console.log("served parses    : YES");
	} catch (error) {
		throw new Error("SERVED BUNDLE IS BROKEN: " + error.message);
	}

	// It must also carry the current anchor, i.e. not a stale valid build.
	const anchor = /right:\s*18px[\s\S]{0,80}?bottom:\s*138px/.test(served) || /bottom:\s*138px/.test(served);
	console.log("bottom-right     : " + (anchor ? "present (bottom: 138px)" : "MISSING - stale bundle"));

	const source = fs.readFileSync(path.join(__dirname, "..", "lib", "client.js"), "utf8");
	const norm = (v) => v.replace(/\r\n/g, "\n").replace(/\/\/# sourceMappingURL=.*$/m, "").replace(/\n;?\s*$/, "\n").trimEnd();
	console.log("matches source   : " + (norm(served) === norm(source) ? "byte-identical" : "DIFFERS"));

	if (!anchor) throw new Error("the served bundle is a stale build without the bottom-right anchor");
	console.log("\nOK: the running instance serves the current, valid, bottom-right bundle.");
})().catch((error) => {
	console.error("FAIL: " + (error && error.message ? error.message : error));
	process.exit(1);
});
