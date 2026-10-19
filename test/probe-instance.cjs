/**
 * Probe a running `dsh web` instance for this plugin's presence.
 *
 *   node test/probe-instance.cjs http://127.0.0.1:31240 <bootstrap-token>
 *
 * Bootstraps the fence with `?token=` to obtain the session cookie, then reports
 * whether the boot graph advertises this package's client row, and whether the
 * host half's balance route answers. The two answers together say which half
 * mounted.
 */
const PLUGIN = "dsh-plugin-balance-hud";
const ROUTE = "/plugin/balance-hud/balance";
const base = process.argv[2];
const token = process.argv[3];

/** Collect Set-Cookie values into one Cookie header. */
function cookiesOf(response) {
	const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
	return raw.map((value) => value.split(";")[0]).join("; ");
}

(async () => {
	let cookie = "";
	if (token !== undefined) {
		const bootstrap = await fetch(base + "/?token=" + token, { redirect: "manual" });
		cookie = cookiesOf(bootstrap);
		console.log("bootstrap  : " + bootstrap.status + (cookie ? " + cookie" : " (no cookie)"));
	}

	const headers = cookie ? { cookie } : {};
	const index = await fetch(base + "/", { headers });
	console.log("index      : " + index.status + " " + index.headers.get("content-type"));
	if (!index.ok) {
		console.log("(cannot read the boot graph without a valid bootstrap token)");
		return;
	}
	const html = await index.text();
	console.log("index bytes: " + html.length);

	// Boot rows are `{id: "...", url: "...", inject: [...]}` entries.
	const marker = "__DSH_BOOT__";
	const at = html.indexOf(marker);
	console.log("boot marker: " + (at >= 0 ? "present at " + at : "ABSENT"));

	const rowPattern = new RegExp('"id"\\s*:\\s*"' + PLUGIN + '"', "g");
	console.log("client row : " + (rowPattern.test(html) ? "PRESENT in boot graph" : "ABSENT from boot graph"));

	const ids = [...html.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
	const pluginIds = ids.filter((id) => id.includes("plugin") || id.includes("xiaowu") || id.includes("balance"));
	console.log("plugin ids : " + JSON.stringify([...new Set(pluginIds)]));

	const route = await fetch(base + ROUTE, { headers });
	const body = await route.text();
	console.log("route      : " + route.status + " " + body.slice(0, 160));
	console.log("");
	console.log(route.status === 404 ? "=> host half did NOT register its route" : "=> host half IS serving the route");
})().catch((error) => {
	console.error("FAIL: " + (error && error.message ? error.message : error));
	process.exit(1);
});
