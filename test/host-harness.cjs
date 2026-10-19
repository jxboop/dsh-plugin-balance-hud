/**
 * Host-half harness for the balance-hud node side.
 *
 * Imports lib/index.js with dynamic import (so the real ES module is exercised),
 * hands `apply` a fake context carrying a fake `webServer` and a fake
 * `credentials` service, then drives the registered route handler the way the
 * web server would and asserts the JSON it writes.
 *
 * `fetch` is stubbed, so this proves the handler's own logic: credential
 * resolution order, the request it builds, the trimming it does, and the shape
 * of what reaches the browser — including that no key ever appears in a
 * response or in the failure text.
 *
 * Run with: node test/host-harness.cjs
 */
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HOST_MODULE = pathToFileURL(path.join(__dirname, "..", "lib", "index.js")).href;

/** One fake ServerResponse that records what the handler wrote. */
function makeResponse() {
	return {
		status: null,
		headers: null,
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(body) {
			this.body = body === undefined ? "" : String(body);
		},
	};
}

/** Register the route through a fake context; returns the handler. */
function mountHost(module, { credentials }) {
	let route = null;
	const disposers = [];
	const ctx = {
		// `apply` reads the injected carrier as a property, which is how Cordis
		// delivers a row declared with `inject: [webServer]`.
		webServer: {
			register(next) {
				route = next;
				return () => {
					route = null;
				};
			},
		},
		get(name) {
			if (name === "credentials") return credentials;
			return undefined;
		},
		effect(fn) {
			disposers.push(fn());
			return () => {};
		},
	};
	module.apply(ctx);
	assert.ok(route !== null, "host half registered no route");
	assert.strictEqual(route.kind, "exact", "route should be an exact-path route");
	return { route, disposers };
}

/** Point global fetch at one canned upstream response. */
function stubUpstream({ status = 200, payload, failTimes = 0 }) {
	let calls = 0;
	const seen = [];
	globalThis.fetch = async (url, options) => {
		calls += 1;
		seen.push({ url, options });
		if (calls <= failTimes) throw new Error("simulated network failure");
		return {
			ok: status >= 200 && status < 300,
			status,
			async json() {
				return payload;
			},
		};
	};
	return { calls: () => calls, seen };
}

const BALANCE = {
	is_available: true,
	balance_infos: [{ currency: "CNY", total_balance: "8.14", granted_balance: "0.00", topped_up_balance: "8.14" }],
};

(async () => {
	// Hermetic credentials: point the file fallback at a temp home so a test
	// never reads the developer's real ~/.dsh/.credentials.yaml. The host half
	// reads DSH_HOME per call, so setting it here is enough.
	const os = require("node:os");
	const fs = require("node:fs");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "balance-hud-test-"));
	const previousHome = process.env.DSH_HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.DSH_HOME = home;
	// Also hide the real profile path so only the temp home can answer.
	process.env.USERPROFILE = home;
	fs.writeFileSync(
		path.join(home, ".credentials.yaml"),
		'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-from-test-file-0001\n'
	);

	const module = await import(HOST_MODULE);
	assert.strictEqual(typeof module.apply, "function", "host half exports no apply()");
	assert.strictEqual(module.ROUTE_PATH, "/plugin/balance-hud/balance", "unexpected route path");

	//#region ── happy path, credential service resolves the key ──
	let upstream = stubUpstream({ payload: BALANCE });
	const resolved = [];
	const { route } = mountHost(module, {
		credentials: {
			async resolve(ref) {
				resolved.push(ref);
				return { value: "sk-test-key-0123456789", source: "env" };
			},
		},
	});

	const res = makeResponse();
	await route.handler({ method: "GET" }, res);
	assert.strictEqual(res.status, 200);
	assert.strictEqual(res.headers["content-type"], "application/json; charset=utf-8");
	assert.strictEqual(res.headers["cache-control"], "no-store");

	const body = JSON.parse(res.body);
	assert.strictEqual(body.ok, true, "expected ok:true, got " + res.body);
	assert.strictEqual(body.isAvailable, true);
	assert.strictEqual(body.source, "env", "source should report where the key came from");
	assert.strictEqual(body.balances.length, 1);
	assert.strictEqual(body.balances[0].total, 8.14, "total should be a number");
	assert.strictEqual(body.balances[0].currency, "CNY");
	assert.strictEqual(body.balances[0].toppedUp, 8.14, "camelCase field for the browser half");
	assert.deepStrictEqual(resolved, ["DEEPSEEK_API_KEY"], "must resolve the documented credential ref");

	// The upstream request must carry the key as a bearer token, and the key must
	// never appear anywhere in the response.
	const first = upstream.seen[0];
	assert.strictEqual(first.options.headers.Authorization, "Bearer sk-test-key-0123456789");
	assert.ok(!res.body.includes("sk-test-key"), "the response leaked the API key");
	assert.ok(!res.body.includes("sk-"), "the response leaked a key-shaped string");
	//#endregion

	//#region ── method guard ──
	const rejected = makeResponse();
	await route.handler({ method: "POST" }, rejected);
	assert.strictEqual(rejected.status, 405);
	assert.strictEqual(JSON.parse(rejected.body).reason, "method");
	//#endregion

	//#region ── no credential at all ──
	// Remove the ref from the temp file as well, so neither seam can answer.
	fs.writeFileSync(path.join(home, ".credentials.yaml"), "version: 1\nrefs: {}\n");
	const noKey = makeResponse();
	const noKeyRoute = mountHost(
		module,
		{ credentials: { async resolve() { return undefined; } } }
	).route;
	await noKeyRoute.handler({ method: "GET" }, noKey);
	const noKeyBody = JSON.parse(noKey.body);
	assert.strictEqual(noKeyBody.ok, false);
	assert.strictEqual(noKeyBody.reason, "nokey", "expected nokey, got " + noKey.body);
	assert.ok(noKeyBody.message.includes("DEEPSEEK_API_KEY"), "the message should name the missing ref");
	// Restore the ref for the cases that follow.
	fs.writeFileSync(path.join(home, ".credentials.yaml"), "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-from-test-file-0001\n");
	//#endregion

	//#region ── the credential service declines, so the file fallback answers ──
	upstream = stubUpstream({ payload: BALANCE });
	const viaFile = makeResponse();
	const viaFileRoute = mountHost(
		module,
		{ credentials: { async resolve() { return undefined; } } }
	).route;
	await viaFileRoute.handler({ method: "GET" }, viaFile);
	const viaFileBody = JSON.parse(viaFile.body);
	assert.strictEqual(viaFileBody.ok, true, "the file fallback should have supplied the key: " + viaFile.body);
	assert.strictEqual(viaFileBody.source, "file", "source should report the file seam");
	assert.strictEqual(upstream.seen[0].options.headers.Authorization, "Bearer sk-from-test-file-0001");
	//#endregion

	//#region ── a key the credential service refuses ──
	upstream = stubUpstream({ status: 401, payload: {} });
	const badKey = makeResponse();
	const badKeyRoute = mountHost(
		module,
		{ credentials: { async resolve() { return { value: "sk-rejected-key-0001", source: "file" }; } } }
	).route;
	await badKeyRoute.handler({ method: "GET" }, badKey);
	const badBody = JSON.parse(badKey.body);
	assert.strictEqual(badBody.ok, false);
	assert.strictEqual(badBody.reason, "auth", "a 401 should be reported as auth, got " + badKey.body);
	assert.ok(!badKey.body.includes("sk-rejected"), "the failure text leaked the key");
	//#endregion

	//#region ── upstream unreachable, then a short-error shape ──
	upstream = stubUpstream({ payload: BALANCE, failTimes: 99 });
	const netFail = makeResponse();
	const netRoute = mountHost(
		module,
		{ credentials: { async resolve() { return { value: "sk-network-test-01", source: "file" }; } } }
	).route;
	await netRoute.handler({ method: "GET" }, netFail);
	const netBody = JSON.parse(netFail.body);
	assert.strictEqual(netBody.ok, false);
	assert.strictEqual(netBody.reason, "network");
	assert.ok(netBody.message.length <= 300, "failure message should stay short");
	//#endregion

	//#region ── a malformed upstream payload ──
	upstream = stubUpstream({ payload: { is_available: true, balance_infos: [] } });
	const empty = makeResponse();
	const emptyRoute = mountHost(
		module,
		{ credentials: { async resolve() { return { value: "sk-shape-test-0001", source: "file" }; } } }
	).route;
	await emptyRoute.handler({ method: "GET" }, empty);
	assert.strictEqual(JSON.parse(empty.body).reason, "shape", "empty balance_infos should be a shape error: " + empty.body);
	//#endregion

	console.log("OK: host half claims the route, resolves the credential ref, calls upstream with a");
	console.log("    bearer token, trims the payload to the browser's shape, and never leaks the");
	console.log("    key in any success or failure response.");
})().catch((error) => {
	console.error("FAIL: " + (error && error.message ? error.message : error));
	process.exit(1);
});
