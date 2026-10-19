/**
 * Mount harness for the balance-hud browser half.
 *
 * Loads lib/client.js with a faked `window.__ModuleLoader__`, a fake React and a
 * fake client Cordis context, then asserts that the bundle materializes, claims
 * exactly the intended sidebar seat, renders the energy core, polls the host
 * route through the real call site, and derives every visual state from real
 * data. This is the no-browser check that the bundle is loadable — and that its
 * component can actually reach the timer service — before the profile restarts.
 *
 * The fake React re-renders when state changes (that is what a real React does),
 * so a settled tree always reflects the data the last poll produced.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

//#region ── a React small enough to run the component, with a render loop ──
/** Component identity -> its hook slots, so state survives a re-render. */
const hookStores = new Map();
/** Components whose state changed and that must render again. */
const dirty = new Set();
/** Last props each component was rendered with, replayed on a re-render. */
const lastProps = new Map();

let slots = [];
let cursor = 0;
let pendingEffects = [];

function selectStore(type) {
	if (!hookStores.has(type)) hookStores.set(type, []);
	slots = hookStores.get(type);
	cursor = 0;
}

function slot() {
	const index = cursor++;
	if (slots[index] === undefined) slots[index] = { value: undefined, deps: undefined };
	return slots[index];
}

function depsEqual(a, b) {
	return a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => value === b[i]);
}

const React = {
	createElement(type, props, ...children) {
		const flat = [];
		for (const child of children) {
			if (Array.isArray(child)) flat.push(...child);
			else if (child === null || child === undefined || child === false) continue;
			else flat.push(child);
		}
		return { type, props: { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat } };
	},	useRef(initial) {
		const s = slot();
		if (s.value === undefined) s.value = { current: initial };
		return s.value;
	},
	useState(initial) {
		const s = slot();
		const owner = currentType;
		if (s.value === undefined) s.value = typeof initial === "function" ? initial() : initial;
		s.set = (next) => {
			s.value = typeof next === "function" ? next(s.value) : next;
			// A real React schedules a re-render; without this the tree would keep
			// reading stale state and every data-driven assertion would be wrong.
			if (owner !== undefined) dirty.add(owner);
		};
		return [s.value, s.set];
	},
	useCallback(fn, deps) {
		const s = slot();
		if (!depsEqual(s.deps, deps)) {
			s.value = fn;
			s.deps = deps;
		}
		return s.value;
	},
	useEffect(fn, deps) {
		const s = slot();
		if (!depsEqual(s.deps, deps)) {
			s.deps = deps;
			pendingEffects.push(fn);
		}
	},
};

//#region ── fake DOM / globals ──
const styleElements = [];
const documentStub = {
	head: { appendChild: (el) => styleElements.push(el) },
	getElementById(id) {
		return styleElements.find((el) => el.id === id) ?? null;
	},
	createElement(tag) {
		return { tagName: tag, id: "", textContent: "" };
	},
	addEventListener() {},
	removeEventListener() {},
};

const windowStub = {
	document: documentStub,
	addEventListener() {},
	removeEventListener() {},
	requestAnimationFrame: () => 1,
	cancelAnimationFrame() {},
};
windowStub.window = windowStub;

globalThis.Node = class Node {};
// The count-up animation drives globalThis.requestAnimationFrame; the stub never
// runs the frame, so the readout lands on its target immediately.
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error("unexpected fetch before the poll effect runs"));
//#endregion

//#region ── the bundle table ──
let registration = null;
windowStub.__ModuleLoader__ = {
	load(def) {
		registration = def;
	},
};

const clientPath = path.join(__dirname, "..", "lib", "client.js");
const source = fs.readFileSync(clientPath, "utf8");
// `fetch`, `Node` and `requestAnimationFrame` resolve through globalThis, so the
// stub only stands in for `window` and `document`.
const run = new Function("window", "document", "console", source);
run(windowStub, documentStub, console);
//#endregion

assert.ok(registration !== null, "bundle did not register with __ModuleLoader__");
assert.strictEqual(registration.id, "dsh-plugin-balance-hud", "unexpected bundle id: " + registration.id);

const exports_ = registration.factory((spec) => {
	if (spec === "react") return React;
	throw new Error("module not in table: " + spec);
});
assert.strictEqual(typeof exports_.apply, "function", "bundle exports no apply()");
assert.ok(Array.isArray(exports_.inject), "bundle exports no inject list");
assert.deepStrictEqual(exports_.inject, ["slots", "timer", "locale"], "unexpected inject list");

//#region ── fake client context ──
let registered = null;
let intervalMs = null;
let armedPoll = null;
const effects = [];
const timer = {
	interval(callback, delay) {
		intervalMs = delay;
		armedPoll = callback;
		return () => {
			armedPoll = null;
		};
	},
};
const ctx = {
	locale: {
		register() {
			return () => {};
		},
	},
	effect(fn, label) {
		effects.push({ label, disposer: fn() });
		return () => {};
	},
	timer,
	slots: {
		inject(key, callback) {
			assert.strictEqual(key, "shell.overlay", "badge must target shell.overlay, got " + key);
			callback();
			return () => {};
		},
		register(options, component) {
			registered = { options, component };
			return () => {};
		},
	},
};

exports_.apply(ctx);

assert.ok(registered !== null, "no slot registration happened");
assert.strictEqual(registered.options.name, "shell.overlay");
assert.strictEqual(registered.options.id, "deepseek-balance-core", "must use its own cell id");
assert.strictEqual(registered.options.order, -10);
assert.strictEqual(typeof registered.component, "function");
assert.ok(styleElements.length === 1, "expected exactly one injected stylesheet");
assert.strictEqual(styleElements[0].id, "dsh-plugin-balance-hud:style");
assert.ok(/bh-spin/.test(styleElements[0].textContent), "stylesheet lost its animations");

// The badge is a frame overlay pinned to the bottom-right corner, and it must opt
// back into pointer events because shell.overlay is click-through by default.
const css = styleElements[0].textContent;
const rootRule = css.slice(css.indexOf("[data-bh-root] {"), css.indexOf("[data-bh-root],"));
assert.ok(/position:\s*fixed/.test(rootRule), "root must be position:fixed to sit in the frame corner");
assert.ok(/bottom:\s*138px/.test(rootRule), "root must clear the pet that owns the bottom-right corner");
assert.ok(/right:\s*18px/.test(rootRule), "root must be anchored to the right edge");
assert.ok(/pointer-events:\s*auto/.test(rootRule), "the click-through overlay entry must opt into pointer events");
//#endregion

//#region ── render / tree helpers ──
let currentType;

/** Expand function components so assertions read the host tree. */
function expand(node) {
	let current = node;
	for (let i = 0; i < 12 && current !== null && typeof current === "object" && typeof current.type === "function"; i += 1) {
		currentType = current.type;
		selectStore(current.type);
		lastProps.set(current.type, current.props ?? {});
		current = current.type(current.props ?? {});
	}
	currentType = undefined;
	return current;
}

/** Collect every element carrying an attribute key anywhere in the tree. */
function collect(node, key, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (Array.isArray(node)) {
		for (const child of node) collect(child, key, found);
		return found;
	}
	if (node.props !== undefined && node.props[key] !== undefined) found.push(node);
	collect(node.props?.children, key, found);
	return found;
}

const one = (node, key) => {
	const found = collect(node, key);
	assert.ok(found.length > 0, "expected at least one [" + key + "] element");
	return found[0];
};

/** Render the registered seat entry the way the slot renderer does. */
function renderSeat(props) {
	pendingEffects = [];
	return expand(registered.component({ timer, ...props }));
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function flushEffects() {
	for (const effect of pendingEffects.splice(0)) effect();
}

/** Re-render every component whose state changed, then run its effects. */
function flushRenders() {
	const pending = [...dirty];
	dirty.clear();
	let tree = null;
	for (const type of pending) {
		tree = expand(React.createElement(type, lastProps.get(type) ?? {}));
	}
	if (tree !== null) flushEffects();
	return tree;
}

/** Let queued promises resolve and any resulting re-renders land. */
async function settle() {
	for (let i = 0; i < 6; i += 1) {
		const hadRenders = dirty.size > 0;
		const tree = flushRenders();
		if (!hadRenders && tree === null) break;
		await tick();
	}
	return null;
}

/** Fire the armed interval callback the way a real tick would, then settle. */
async function tickPoll() {
	assert.ok(armedPoll !== null, "no interval callback is armed");
	armedPoll();
	await settle();
	pendingEffects = [];
	return renderSeat();
}

/** Point the stubbed global fetch at one canned JSON payload. */
function stubFetch(payload) {
	let requested = null;
	globalThis.fetch = async (url, options) => {
		requested = { url, options };
		return {
			ok: true,
			status: 200,
			async json() {
				return payload;
			},
		};
	};
	return () => requested;
}
//#endregion

const SUCCESS = {
	ok: true,
	isAvailable: true,
	source: "credentials",
	at: Date.UTC(2026, 0, 2, 3, 4, 5),
	balances: [{ currency: "CNY", total: 8.14, totalText: "8.14", granted: 2, toppedUp: 6.14 }],
};

(async () => {
	//#region ── mount render: no data yet ──
	hookStores.clear();
	dirty.clear();
	let tree = renderSeat();
	assert.strictEqual(tree.type, "div");
	assert.ok(tree.props["data-bh-root"] !== undefined, "root should carry the data-bh-root marker");

	const idleBadge = one(tree, "data-bh-badge");
	assert.strictEqual(idleBadge.type, "button");
	assert.ok(
		String(idleBadge.props["aria-label"]).includes("同步"),
		"unresolved badge should read as syncing: " + idleBadge.props["aria-label"]
	);
	assert.strictEqual(one(tree, "data-bh-icon").props["data-state"], "error", "no data yet should render the error state");
	assert.strictEqual(collect(tree, "data-bh-panel").length, 0, "panel must start collapsed");

	// The mount render queues the count-up effect, the outside-click effect and
	// the poll effect. Flushing them fires the first poll and arms the interval.
	const requested = stubFetch(SUCCESS);
	assert.ok(pendingEffects.length >= 1, "the mount render queued no effects at all");
	flushEffects();
	assert.strictEqual(intervalMs, 45000, "collapsed poll interval should be 45s, got " + intervalMs);
	const seen = requested();
	assert.ok(seen !== null, "no poll effect fired on mount");
	assert.strictEqual(seen.url, "/plugin/balance-hud/balance", "wrong route: " + seen.url);
	assert.strictEqual(seen.options.cache, "no-store", "poll must not be served from cache");
	//#endregion

	//#region ── a successful poll renders the warn band ──
	await settle();
	tree = renderSeat();
	const badge = one(tree, "data-bh-badge");
	assert.ok(String(badge.props.title).includes("8.14"), "badge title lost the amount: " + badge.props.title);
	assert.ok(String(badge.props.title).includes("¥"), "badge title lost the currency symbol: " + badge.props.title);

	const icon = one(tree, "data-bh-icon");
	assert.strictEqual(icon.props["data-state"], "warn", "¥8.14 should sit in the amber band, got " + icon.props["data-state"]);
	assert.strictEqual(icon.props["data-tick"], "true", "a settled refresh should pulse the core");

	const gauge = one(tree, "data-bh-gauge");
	assert.ok(/^[0-9.]+%$/.test(gauge.props.children.props.style.width), "gauge width is not a percentage");
	//#endregion

	//#region ── the panel opens on the badge's own click handler ──
	one(renderSeat(), "data-bh-badge").props.onClick();
	await settle();
	const opened = renderSeat();
	const panel = one(opened, "data-bh-panel");
	const status = one(panel, "data-bh-status");
	assert.strictEqual(status.props["data-state"], "ok");
	assert.ok(String(status.props.children).includes("API 可用"), "healthy status text missing: " + status.props.children);
	const grantedBar = collect(panel, "data-bh-bar").find((bar) => bar.props["data-kind"] === "granted");
	assert.ok(grantedBar !== undefined, "granted-credit bar missing from the panel");
	assert.strictEqual(one(opened, "data-bh-badge").props["aria-expanded"], true, "panel should be expanded");
	assert.strictEqual(intervalMs, 15000, "an open panel should poll at 15s, got " + intervalMs);
	//#endregion

	//#region ── a frame overlay always renders its full readout ──
	// There is no rail state in the overlay, so the text block is always present
	// and the badge never carries the old sidebar-specific rail marker.
	const overlayTree = renderSeat();
	assert.strictEqual(one(overlayTree, "data-bh-badge").props["data-rail"], undefined, "overlay badge has no rail mode");
	assert.strictEqual(collect(overlayTree, "data-bh-text").length, 1, "the readout must always render");
	assert.strictEqual(collect(overlayTree, "data-bh-icon").length, 1, "the core must render");
	//#endregion

	//#region ── a failing poll surfaces, and does not crash ──
	stubFetch({ ok: false, reason: "nokey", message: "未找到可用的 DEEPSEEK_API_KEY" });
	tree = await tickPoll();
	assert.strictEqual(one(tree, "data-bh-icon").props["data-state"], "error", "a failed poll must render the error state");
	assert.strictEqual(one(tree, "data-bh-sub").props["data-state"], "error");
	//#endregion

	//#region ── a low balance escalates to the danger band ──
	stubFetch({ ok: true, isAvailable: true, at: Date.now(), balances: [{ currency: "USD", total: 0.5, granted: 0, toppedUp: 0.5 }] });
	tree = await tickPoll();
	assert.strictEqual(one(tree, "data-bh-icon").props["data-state"], "danger", "$0.50 should sit in the crimson band");
	assert.ok(String(one(tree, "data-bh-badge").props.title).includes("$"), "USD should render the dollar symbol");
	//#endregion

	console.log("OK: bundle materializes, injects one stylesheet, claims its own shell.overlay cell");
	console.log("    pinned to the top-left, renders the energy core, polls the host route, and");
	console.log("    derives ok / warn / danger / error states from real data.");
})().catch((error) => {
	console.error("FAIL: " + (error && error.message ? error.message : error));
	process.exit(1);
});
