/**
 * DeepSeek Balance Core — node half (bundle id: dsh-plugin-balance-hud).
 *
 * Owns the whole credential side of the feature, so the API key never reaches
 * the browser:
 *
 *   - resolve `DEEPSEEK_API_KEY` through the *credentials* Cordis service when
 *     this composition mounts one, falling back to the layered credential file
 *     (`$DSH_HOME/.credentials.yaml`) otherwise;
 *   - call `GET /user/balance` with the plain Node fetch available to the host;
 *   - serve the trimmed result as JSON on one exact HTTP route, which is what
 *     the browser half polls.
 *
 * The route answers a fixed shape and never echoes the key: on failure it
 * reports a short reason, not the upstream error body.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Credential reference name, matching the layered credential store. */
const CRED_REF = "DEEPSEEK_API_KEY";

/** Where the browser half reads the balance from. */
export const ROUTE_PATH = "/plugin/balance-hud/balance";

/** Upstream balance endpoint, plus the documented compatibility prefix. */
const BALANCE_URLS = ["https://api.deepseek.com/user/balance", "https://api.deepseek.com/v1/user/balance"];

/** Only a real key shape is ever turned into an Authorization header. */
const KEY_PATTERN = /^[A-Za-z0-9._-]{8,256}$/;

/** Per-request upstream budget. */
const REQUEST_TIMEOUT_MS = 15000;

/** How long one resolved key stays good for a retry after an auth failure. */
const KEY_CACHE_MS = 30000;

/**
 * Append one line to a diagnostic file, best effort.
 *
 * A host row that mounts but registers nothing is indistinguishable from a
 * broken plugin at the browser, and `ctx.logger` output is not reachable from
 * outside the process, so activation records its own evidence here.
 */
function startupLog(message) {
	const file = process.env.DSH_BALANCE_HUD_LOG;
	if (typeof file !== "string" || file.length === 0) return;
	try {
		appendFileSync(file, new Date().toISOString() + " " + message + "\n");
	} catch {
		// Diagnostics must never break activation.
	}
}

/** Trim one unknown balance entry down to the scalars the badge renders. */
function toBalance(entry) {
	if (entry === null || typeof entry !== "object") return null;
	const currency = typeof entry.currency === "string" ? entry.currency : "CNY";
	const total = Number(entry.total_balance);
	if (!Number.isFinite(total)) return null;
	return {
		currency,
		total,
		totalText: typeof entry.total_balance === "string" ? entry.total_balance : String(total),
		granted: Number(entry.granted_balance),
		toppedUp: Number(entry.topped_up_balance),
	};
}

/** The layered credential file this deployment writes refs into. */
function credentialFileCandidates() {
	const candidates = [];
	const home = process.env.DSH_HOME;
	if (typeof home === "string" && home.length > 0) candidates.push(join(home, ".credentials.yaml"));
	const profile = process.env.USERPROFILE ?? process.env.HOME;
	if (typeof profile === "string" && profile.length > 0) candidates.push(join(profile, ".dsh", ".credentials.yaml"));
	return candidates;
}

/** Read `DEEPSEEK_API_KEY` out of one YAML refs section without a YAML parser. */
function readKeyFromFile() {
	for (const file of credentialFileCandidates()) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const match = text.match(new RegExp("(?:^|\\n)\\s*" + CRED_REF + "\\s*:\\s*([^\\r\\n#]+)"));
		if (match === null) continue;
		const value = match[1].trim().replace(/^['"]|['"]$/g, "").trim();
		if (value.length > 0) return { value, source: "file" };
	}
	return { value: "", source: "unavailable" };
}

/**
 * Resolve the key, preferring the credential service so an inherited
 * environment variable or a provider-managed store wins over the file — the
 * same layering the credential service itself documents.
 */
async function resolveKey(ctx) {
	const credentials = ctx.get("credentials");
	if (credentials !== undefined && typeof credentials.resolve === "function") {
		try {
			const resolved = await credentials.resolve(CRED_REF);
			if (resolved !== null && typeof resolved === "object" && typeof resolved.value === "string") {
				const value = resolved.value.trim();
				if (value.length > 0) return { value, source: String(resolved.source ?? "credentials") };
			}
		} catch {
			// Fall through to the file: a failing service must not break the badge.
		}
	}
	return readKeyFromFile();
}

/** Fetch the balance once; returns the JSON payload the browser half expects. */
async function fetchBalance(key) {
	let lastError = "upstream unreachable";
	for (const url of BALANCE_URLS) {
		let response;
		try {
			response = await fetch(url, {
				method: "GET",
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			continue;
		}
		if (response.status === 401 || response.status === 403) {
			return { ok: false, reason: "auth", message: "API Key 被拒绝（HTTP " + response.status + "）" };
		}
		if (!response.ok) {
			lastError = "HTTP " + response.status;
			continue;
		}
		let data;
		try {
			data = await response.json();
		} catch {
			lastError = "响应不是合法 JSON";
			continue;
		}
		const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
		const balances = [];
		for (const entry of infos) {
			const balance = toBalance(entry);
			if (balance !== null) balances.push(balance);
		}
		if (balances.length === 0) return { ok: false, reason: "shape", message: "接口未返回余额条目" };
		return { ok: true, isAvailable: data.is_available === true, balances, at: Date.now() };
	}
	return { ok: false, reason: "network", message: lastError };
}

/** Serve one JSON response; the route owns its full lifecycle. */
function sendJson(res, status, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.byteLength),
		"cache-control": "no-store",
	});
	res.end(body);
}

/**
 * Host plugin body: claim the balance route.
 *
 * The bundle row declares `inject: [webServer]`, so Cordis parks this row until
 * the web carrier exists and then calls `apply` with it already live. That is
 * why there is no retry loop here: a row that activated before its carrier would
 * register nothing, which the browser can only see as a permanent "signal lost".
 *
 * @param ctx - host root context carrying the injected `webServer`.
 */
export function apply(ctx) {
	/** Last resolved key plus when it was read, so a poll loop reads the file once. */
	let cached = { value: "", source: "", at: 0 };

	/** One in-flight request shared by concurrent polls. */
	let inFlight = null;

	async function currentKey(force) {
		const fresh = Date.now() - cached.at < KEY_CACHE_MS;
		if (fresh && cached.value.length > 0 && !force) return cached;
		const next = await resolveKey(ctx);
		cached = { value: next.value, source: next.source, at: Date.now() };
		return cached;
	}

	async function handle() {
		const key = await currentKey(false);
		if (key.value.length === 0 || !KEY_PATTERN.test(key.value)) {
			return { ok: false, reason: "nokey", message: "未找到可用的 " + CRED_REF + "，请先配置 DeepSeek API Key" };
		}
		const result = await fetchBalance(key.value);
		if (result.ok) return { ...result, source: key.source };
		// A rejected key may simply be a stale cached one: re-resolve once.
		if (result.reason === "auth") {
			const retried = await currentKey(true);
			if (retried.value !== key.value && KEY_PATTERN.test(retried.value)) {
				const second = await fetchBalance(retried.value);
				if (second.ok) return { ...second, source: retried.source };
				return second;
			}
		}
		return result;
	}

	const webServer = ctx.webServer;
	if (webServer === undefined) {
		// The bundle row declares this dependency, so reaching here means the
		// composition is wrong rather than merely early.
		startupLog("apply() entered but ctx.webServer is undefined — check the row's inject list");
		return;
	}

	ctx.effect(
		() =>
			webServer.register({
				kind: "exact",
				path: ROUTE_PATH,
				async handler(req, res) {
					if (req.method !== "GET" && req.method !== "HEAD") {
						sendJson(res, 405, { ok: false, reason: "method", message: "只支持 GET" });
						return;
					}
					if (inFlight === null) {
						inFlight = handle().finally(() => {
							inFlight = null;
						});
					}
					let payload;
					try {
						payload = await inFlight;
					} catch (error) {
						payload = {
							ok: false,
							reason: "internal",
							message: error instanceof Error ? error.message : String(error),
						};
					}
					sendJson(res, 200, payload);
				},
			}),
		"balance-hud: balance route",
	);

	startupLog("apply() registered " + ROUTE_PATH);
	ctx.logger?.info?.("balance-hud: serving " + ROUTE_PATH);
}
