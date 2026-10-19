/**
 * Gesture harness for the balance-hud browser half.
 *
 * The badge is draggable and can tuck itself into the right edge. Both are
 * behaviours that no data assertion in harness.cjs can see, so this check drives
 * the real pointer call sites: a drag must move the root, clamp inside the
 * viewport, persist its position and NOT toggle the panel; the tuck handle must
 * pin the root to the right edge; and a click on the tucked sliver must restore
 * the remembered spot.
 *
 *   node test/gestures.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

//#region ── a React small enough to run the component, with a render loop ──
const hookStores = new Map();
const dirty = new Set();
const lastProps = new Map();

let slots = [];
let cursor = 0;
let pendingEffects = [];
let currentType;

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
	},
	useRef(initial) {
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
//#endregion

//#region ── fake DOM / window / storage ──
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

const store = new Map();
const localStorageStub = {
	getItem: (key) => (store.has(key) ? store.get(key) : null),
	setItem: (key, value) => store.set(key, String(value)),
	removeItem: (key) => store.delete(key),
};

const windowStub = {
	document: documentStub,
	innerWidth: 1200,
	innerHeight: 800,
	localStorage: localStorageStub,
	addEventListener() {},
	removeEventListener() {},
	requestAnimationFrame: () => 1,
	cancelAnimationFrame() {},
};
windowStub.window = windowStub;

globalThis.Node = class Node {};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const SUCCESS = {
	ok: true,
	isAvailable: true,
	at: Date.UTC(2026, 0, 2, 3, 4, 5),
	balances: [{ currency: "CNY", total: 8.14, granted: 2, toppedUp: 6.14 }],
};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SUCCESS });

let registration = null;
windowStub.__ModuleLoader__ = { load: (def) => (registration = def) };
const source = fs.readFileSync(path.join(__dirname, "..", "lib", "client.js"), "utf8");
new Function("window", "document", "console", source)(windowStub, documentStub, console);

const exports_ = registration.factory((spec) => {
	if (spec === "react") return React;
	throw new Error("module not in table: " + spec);
});

// apply() is what injects the stylesheet; run it once so the CSS assertions
// below read the real rules the browser half ships.
exports_.apply({
	locale: { register: () => () => {} },
	effect: (fn) => {
		fn();
		return () => {};
	},
	slots: {
		inject: (name, fn) => fn(),
		register: (options, component) => ({ options, component }),
	},
});
//#endregion

//#region ── render / tree helpers ──
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

/** Give every `ref` in the tree a fake node with a settable box. */
function attachRefs(node, created = []) {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) attachRefs(child, created);
		return;
	}
	const props = node.props ?? {};
	const ref = props.ref;
	if (ref !== undefined && ref !== null && ref.current == null) {
		ref.current = {
			rect: { left: 0, top: 0, width: 150, height: 46 },
			getBoundingClientRect() {
				return this.rect;
			},
			setPointerCapture() {},
			releasePointerCapture() {},
		};
		created.push(ref.current);
	}
	attachRefs(props.children, created);
}

let created = [];
function renderSeat() {
	pendingEffects = [];
	created = [];
	const tree = expand(React.createElement(exports_.BalanceCore, { timer: { interval: () => () => {} } }));
	attachRefs(tree, created);
	return tree;
}

function flushEffects() {
	for (const effect of pendingEffects.splice(0)) effect();
}

function flushRenders() {
	const pending = [...dirty];
	dirty.clear();
	let tree = null;
	for (const type of pending) {
		created = [];
		tree = expand(React.createElement(type, lastProps.get(type) ?? {}));
		attachRefs(tree, created);
	}
	if (tree !== null) flushEffects();
	return tree;
}

const box = (left, top, width = 150, height = 46) => ({ left, top, width, height });
//#endregion

//#region ── the checks ──
let tree = renderSeat();
attachRefs(tree);

const root = () => one(tree, "data-bh-root");
const badge = () => one(tree, "data-bh-badge");
const badgeNode = badge().props.ref.current;
badgeNode.rect = box(900, 600);

assert.ok(root().props["data-collapsed"] === "false", "a fresh badge starts expanded");
assert.strictEqual(collect(tree, "data-bh-collapse").length, 1, "the tuck handle must be reachable");

// A sub-threshold move is still a click: no position, no drag state.
badge().props.onPointerDown({ button: 0, pointerId: 7, clientX: 900, clientY: 600, currentTarget: badgeNode });
badge().props.onPointerMove({ pointerId: 7, clientX: 902, clientY: 601, preventDefault() {} });
assert.strictEqual(root().props["data-dragging"], "false", "2px of travel must not arm a drag");

// A real drag moves the root, persists its position and does NOT tuck in open space.
badge().props.onPointerMove({ pointerId: 7, clientX: 500, clientY: 350, preventDefault() {} });
tree = flushRenders() ?? tree;
attachRefs(tree);
assert.strictEqual(root().props["data-dragging"], "true", "a long move must arm a drag");
assert.strictEqual(root().props.style.left, "500px", "the root must follow the pointer horizontally");
assert.strictEqual(root().props.style.top, "350px", "the root must follow the pointer vertically");
assert.strictEqual(root().props.style.right, "auto", "an explicit left must release the CSS right anchor");
assert.strictEqual(root().props.style.bottom, "auto", "an explicit top must release the CSS bottom anchor");

badge().props.onPointerUp({ pointerId: 7, currentTarget: badgeNode });
assert.deepStrictEqual(JSON.parse(store.get("dsh-plugin-balance-hud:pos")), { x: 500, y: 350 }, "the moved position must persist");
tree = flushRenders() ?? tree;
attachRefs(tree);
assert.strictEqual(root().props["data-edge"], "none", "releasing in open space must not tuck");

// The release click belongs to the drag, not to the panel.
badge().props.onClick();
tree = flushRenders() ?? tree;
attachRefs(tree);
assert.strictEqual(collect(tree, "data-bh-panel").length, 0, "the click ending a drag must not open the panel");

/** Drag from the badge's current box to a target, release, and swallow the
 *  click the browser fires afterwards — exactly what a mouse drag produces. */
function dragTo(pointerId, fromX, fromY, toX, toY, onMove) {
	badgeNode.rect = box(fromX, fromY);
	badge().props.onPointerDown({ button: 0, pointerId, clientX: fromX, clientY: fromY, currentTarget: badgeNode });
	badge().props.onPointerMove({ pointerId, clientX: toX, clientY: toY, preventDefault() {} });
	tree = flushRenders() ?? tree;
	attachRefs(tree);
	// Mid-drag assertions run before the release decides whether to tuck.
	if (onMove !== undefined) onMove();
	badge().props.onPointerUp({ pointerId, currentTarget: badgeNode });
	tree = flushRenders() ?? tree;
	attachRefs(tree);
	badge().props.onClick();
	tree = flushRenders() ?? tree;
	attachRefs(tree);
}

// Releasing at the right edge (clamped to 1040) tucks into the right edge.
dragTo(11, 500, 350, 5000, 350, () => {
	assert.strictEqual(root().props.style.left, "1040px", "the badge must clamp to the right edge minus its width");
	assert.strictEqual(root().props.style.top, "350px", "the drag must keep the vertical position");
});
assert.strictEqual(root().props["data-edge"], "right", "releasing at the right edge must tuck into it");
assert.strictEqual(root().props.style.left, "1040px", "a tuck keeps the layout anchor and only translates");
assert.strictEqual(root().props.style.right, "auto", "a tuck must not re-anchor the box");
assert.strictEqual(root().props.style.transform, "translate(138px, 0px)", "a right tuck slides to a 22px sliver (1200 - 22 - 1040)");
assert.strictEqual(store.get("dsh-plugin-balance-hud:tuck"), "right", "the tuck edge must persist");
assert.strictEqual(collect(tree, "data-bh-collapse").length, 0, "a tucked badge offers no tuck handle");
assert.strictEqual(collect(tree, "data-bh-text").length, 1, "the readout stays in the tree and is faded by CSS");

// Clicking the sliver expands back to the remembered spot.
badge().props.onClick();
tree = flushRenders() ?? tree;
attachRefs(tree);
assert.strictEqual(root().props["data-edge"], "none", "clicking the sliver must expand the badge");
assert.strictEqual(root().props.style.left, "1040px", "expanding must restore the remembered x");
assert.strictEqual(root().props.style.transform, "translate(0px, 0px)", "expanding must slide the badge back home");
assert.strictEqual(store.get("dsh-plugin-balance-hud:tuck"), "", "expanding must persist the open state");

// Releasing at the left edge tucks left.
dragTo(12, 1040, 350, -5000, 350);
assert.strictEqual(root().props.style.left, "10px", "a left tuck keeps the layout anchor and only translates");
assert.strictEqual(root().props.style.top, "350px", "a side tuck keeps the vertical position");
assert.strictEqual(root().props["data-edge"], "left", "releasing at the left edge must tuck into it");
assert.strictEqual(root().props.style.transform, "translate(-138px, 0px)", "a left tuck slides the badge's right edge to a 22px sliver");
badge().props.onClick();
tree = flushRenders() ?? tree;
attachRefs(tree);
assert.strictEqual(root().props.style.left, "10px", "expanding must restore the clamped x");
assert.strictEqual(root().props.style.transform, "translate(0px, 0px)", "expanding must slide the badge back home");

// Releasing at the top edge tucks upward (x kept away from the corners).
dragTo(13, 10, 350, 500, -5000);
assert.strictEqual(root().props.style.top, "10px", "a top tuck keeps the layout anchor and only translates");
assert.strictEqual(root().props.style.left, "500px", "a top tuck keeps the horizontal position");
assert.strictEqual(root().props["data-edge"], "top", "releasing at the top edge must tuck into it");
assert.strictEqual(root().props.style.transform, "translate(0px, -34px)", "a top tuck slides its bottom edge to a 22px sliver");
badge().props.onClick();
tree = flushRenders() ?? tree;
attachRefs(tree);
assert.strictEqual(root().props.style.top, "10px", "expanding restores the position the badge was released at");
assert.strictEqual(root().props.style.transform, "translate(0px, 0px)", "expanding must slide the badge back home");

// Releasing at the bottom edge tucks downward.
dragTo(14, 500, 10, 500, 5000);
assert.strictEqual(root().props.style.top, "744px", "a bottom tuck keeps the layout anchor and only translates");
assert.strictEqual(root().props["data-edge"], "bottom", "releasing at the bottom edge must tuck into it");
assert.strictEqual(root().props.style.transform, "translate(0px, 34px)", "a bottom tuck slides its top edge to a 22px sliver");
badge().props.onClick();
tree = flushRenders() ?? tree;
attachRefs(tree);
assert.strictEqual(root().props.style.top, "744px", "expanding must restore the clamped y");
assert.strictEqual(root().props.style.transform, "translate(0px, 0px)", "expanding must slide the badge back home");

// The manual handle picks the nearest edge on its own (this spot hugs the bottom).
const handle = one(tree, "data-bh-collapse");
handle.props.onClick();
tree = flushRenders() ?? tree;
attachRefs(tree);
assert.strictEqual(root().props["data-edge"], "bottom", "the handle tucks into the nearest edge");
assert.strictEqual(store.get("dsh-plugin-balance-hud:collapsed"), "1", "the legacy flag stays in sync");

// The tuck must be animated, not a one-frame flip.
const css = styleElements[0].textContent;
assert.ok(/transition:\s*transform\s+\d+ms/.test(css), "the root must transition its transform");
assert.ok(/\[data-bh-root\]\[data-collapsed="true"\] \[data-bh-text\][^{]*\{[^}]*opacity:\s*0/.test(css), "tucked text must fade, not vanish");
assert.ok(!/\[data-bh-root\]\[data-collapsed="true"\] \[data-bh-text\][^{]*\{[^}]*display:\s*none/.test(css), "tucked text must keep its box so the slide stays smooth");

console.log("OK: badge drags, clamps, persists, auto-tucks into all four edges and expands from the sliver");
//#endregion
