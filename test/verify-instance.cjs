/**
 * Verify that a running `dsh web` instance serves this plugin's client bundle.
 *
 *   node test/verify-instance.cjs http://127.0.0.1:31239 <bootstrap-token>
 *
 * Reads the boot graph out of the served index, finds this package's row, then
 * fetches the exact bundled URL the graph advertises and checks the body is the
 * authored bundle (the route appends its own source-map line and a sentinel).
 * Also probes the balance route the host half claims.
 */
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN = "dsh-plugin-balance-hud";
const ROUTE = "/plugin/balance-hud/balance";
const base = process.argv[2] ?? "http://127.0.0.1:31239";
const token = process.argv[3];

/** Pull the `globalThis["__DSH_BOOT__"] = {...}` object literal out of the index. */
function bootGraphOf(html) {
	const marker = html.indexOf('__DSH_BOOT__"]');
	if (marker < 0) throw new Error("index served no __DSH_BOOT__ marker");
	const start = html.indexOf("{", marker);
	if (start < 0) throw new Error("boot marker carries no object literal");
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
	throw new Error("boot object literal is unterminated");
}

/** The web fence trades `?token=` for a session cookie; keep whichever arrives. */
function cookieOf(response) {
	const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
	return raw.map((value) => value.split(";")[0]).join("; ");
}

(async () => {
	console.log("target            : " + base);
	const indexResponse = await fetch(base + "/");
	if (!indexResponse.ok) throw new Error("index status " + indexResponse.status);
	const cookie = cookieOf(indexResponse);
	const html = await indexResponse.text();
	console.log("index             : " + html.length + " bytes" + (cookie ? ", cookie acquired" : ""));

	const boot = bootGraphOf(html);
	const rows = (boot.entries ?? []).filter((entry) => entry.id === PLUGIN);
	if (rows.length !== 1) {
		const ids = (boot.entries ?? []).map((entry) => entry.id);
		throw new Error("boot graph holds " + rows.length + " rows for " + PLUGIN + "; saw: " + JSON.stringify(ids));
	}
	const row = rows[0];
	console.log("boot row          : " + row.id);
	console.log("boot url          : " + row.url);
	console.log("inject edges      : " + JSON.stringify(row.inject ?? []));

	// The advertised URL already carries the revision, so nothing may be appended.
	const bundleResponse = await fetch(base + row.url, { headers: cookie ? { cookie } : {} });
	console.log("bundle response   : " + bundleResponse.status + " " + bundleResponse.headers.get("content-type"));
	if (!bundleResponse.ok) throw new Error("bundle fetch failed");
	const served = await bundleResponse.text();
	const source = fs.readFileSync(path.join(__dirname, "..", "lib", "client.js"), "utf8");

	const normalize = (value) => value.replace(/\r\n/g, "\n").replace(/\/\/# sourceMappingURL=.*$/m, "").replace(/\n;?\s*$/, "\n").trimEnd();
	if (normalize(served) !== normalize(source)) {
		throw new Error("served bundle differs from the authored lib/client.js");
	}
	if (!served.includes("window.__ModuleLoader__.load")) throw new Error("served bundle is not a module registration");
	if (!served.includes('id: "' + PLUGIN + '"')) throw new Error("served bundle id mismatch");
	console.log("bundle body       : identical to lib/client.js (source-map line aside)");

	// The host half's route must answer with JSON.
	const balanceResponse = await fetch(base + ROUTE, { headers: cookie ? { cookie } : {} });
	const text = await balanceResponse.text();
	console.log("balance route     : " + balanceResponse.status + " " + text.slice(0, 200));
	if (!balanceResponse.ok) throw new Error("balance route status " + balanceResponse.status);
	const payload = JSON.parse(text);
	if (typeof payload.ok !== "boolean") throw new Error("balance route returned an unexpected shape: " + text);
	if (payload.ok === true) {
		console.log("balance value     : " + payload.balances[0].total + " " + payload.balances[0].currency + " (via " + payload.source + ")");
	} else {
		console.log("balance reason    : " + payload.reason + " - " + payload.message);
	}

	console.log("\nOK: the instance advertises this plugin in its boot graph, serves the bundle");
	console.log("    byte-for-byte, and its host half answers the balance route.");
})().catch((error) => {
	console.error("FAIL: " + (error && error.message ? error.message : error));
	process.exit(1);
});
