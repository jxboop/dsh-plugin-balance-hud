/**
 * DeepSeek Balance Core — browser half (bundle id: dsh-plugin-balance-hud).
 *
 * A persistent "energy core" badge in the sidebar foot that shows the live
 * DeepSeek account balance in a sci-fi / xianxia register: a rotating conic
 * energy ring around a pulsing core, a gradient readout that counts toward each
 * new value, and a gauge that shortens and changes hue as the balance drains.
 *
 * Clicking the badge opens a clipped holographic panel with the split between
 * granted and topped-up credit, the API availability state, and the last sync
 * time. Polling runs at 45s collapsed and 15s while the panel is open.
 *
 * All data comes from this package's host half over one exact HTTP route, so
 * the API key stays in the node process.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-balance-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useCallback, useEffect, useRef, useState } = React;

		/** JSX-free element helper: this bundle is hand-written, not built. */
		const h = React.createElement;

		const NS = "balanceHud";
		const ROUTE = "/plugin/balance-hud/balance";
		const STYLE_ID = "dsh-plugin-balance-hud:style";

		/** Poll cadence: lazier while collapsed, brisk while the panel is open. */
		const IDLE_MS = 45000;
		const ACTIVE_MS = 15000;

		/** Balance that fills the gauge; above this the bar simply stays full. */
		const FULL_SCALE = 50;

		/** Alerts: at or below these the core turns amber, then crimson. */
		const WARN_AT = 10;
		const DANGER_AT = 1;

		/** Drag / tuck behaviour. */
		const POS_KEY = "dsh-plugin-balance-hud:pos";
		const TUCK_KEY = "dsh-plugin-balance-hud:tuck";
		/** Earlier builds only knew "tucked to the right": read it once to migrate. */
		const LEGACY_COLLAPSE_KEY = "dsh-plugin-balance-hud:collapsed";
		/** Minimum gap kept between the badge and any viewport edge. */
		const EDGE = 10;
		/** How much of the badge stays visible while tucked into an edge. */
		const SLIVER = 22;
		/** Releasing the badge this close to an edge tucks it in. */
		const EDGE_SNAP = 30;
		/** Pointer travel (px) that turns a click into a drag. */
		const DRAG_THRESHOLD = 4;
		/** A click landing this soon after a drag belongs to the drag. */
		const CLICK_GUARD_MS = 400;
		/** The four edges a badge can tuck into. */
		const EDGES = ["left", "right", "top", "bottom"];

		const SYMBOLS = { CNY: "¥", USD: "$" };

		const CSS = `
[data-bh-root] {
  --bh-cyan: #35e6ff;
  --bh-violet: #a06bff;
  --bh-amber: #ffc457;
  --bh-crimson: #ff5d73;
  /* The frame-wide overlay is click-through by design, so this entry opts back
     into pointer events for itself only, and pins itself to the bottom-right
     corner. The bottom offset clears the xiaowu pet, which owns that corner:
     112px tall at bottom:14px, so it reaches 126px above the frame's bottom. */
  position: fixed;
  right: 18px;
  bottom: 138px;
  z-index: 40;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  /* Tucking and expanding slide by a pixel offset, so one transition covers
     both directions. Position itself never animates: the drag stays 1:1. */
  transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}
[data-bh-root], [data-bh-root] * { box-sizing: border-box; }

/* ---------- the badge ---------- */
[data-bh-badge] {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px 7px 8px;
  border: 0;
  border-radius: 14px;
  background:
    radial-gradient(120% 160% at 12% 50%, rgba(53, 230, 255, 0.16), transparent 62%),
    linear-gradient(135deg, rgba(14, 30, 52, 0.92), rgba(10, 16, 34, 0.86));
  box-shadow:
    inset 0 0 0 1px rgba(53, 230, 255, 0.28),
    inset 0 0 14px rgba(53, 230, 255, 0.08),
    0 2px 12px rgba(0, 0, 0, 0.35);
  color: #dff6ff;
  cursor: pointer;
  font-family: inherit;
  overflow: hidden;
  transition: box-shadow 220ms ease, transform 160ms ease;
}
[data-bh-badge]:hover {
  box-shadow:
    inset 0 0 0 1px rgba(53, 230, 255, 0.55),
    inset 0 0 18px rgba(53, 230, 255, 0.16),
    0 0 16px rgba(53, 230, 255, 0.28);
}
[data-bh-badge]:active { transform: translateY(1px); }
[data-bh-badge]:focus-visible { outline: 2px solid var(--bh-cyan); outline-offset: 2px; }

/* gauge pinned to the badge floor */
[data-bh-gauge] {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.07);
}
[data-bh-gauge] i {
  display: block;
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--bh-cyan), var(--bh-violet));
  box-shadow: 0 0 8px rgba(53, 230, 255, 0.9);
  transition: width 700ms cubic-bezier(0.22, 1, 0.36, 1), background 400ms linear;
}

/* ---------- energy core ---------- */
[data-bh-icon] {
  position: relative;
  width: 38px; height: 38px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 11px;
  background: rgba(6, 14, 28, 0.7);
}
[data-bh-ring] {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0deg 225deg, var(--bh-cyan) 300deg, #ffffff 330deg, transparent 360deg);
  -webkit-mask: radial-gradient(circle, transparent 0 13px, #000 14px 15px, transparent 16px);
  mask: radial-gradient(circle, transparent 0 13px, #000 14px 15px, transparent 16px);
  animation: bh-spin 4.2s linear infinite;
  opacity: 0.9;
}
[data-bh-core] {
  width: 16px; height: 16px;
  border-radius: 5px;
  background: linear-gradient(140deg, #eafcff, var(--bh-cyan) 45%, var(--bh-violet));
  box-shadow: 0 0 14px rgba(53, 230, 255, 0.85), 0 0 4px #fff inset;
  animation: bh-pulse 2.8s ease-in-out infinite;
}
[data-bh-icon][data-state="warn"] [data-bh-core] { background: linear-gradient(140deg, #fff4d8, var(--bh-amber)); box-shadow: 0 0 10px rgba(255, 196, 87, 0.85); }
[data-bh-icon][data-state="warn"] [data-bh-ring] { background: conic-gradient(from 0deg, transparent 0deg 225deg, var(--bh-amber) 300deg, #fff 330deg, transparent 360deg); }
[data-bh-icon][data-state="danger"] [data-bh-core] { background: linear-gradient(140deg, #ffe3e7, var(--bh-crimson)); box-shadow: 0 0 10px rgba(255, 93, 115, 0.9); }
[data-bh-icon][data-state="danger"] [data-bh-ring] { background: conic-gradient(from 0deg, transparent 0deg 225deg, var(--bh-crimson) 300deg, #fff 330deg, transparent 360deg); }
[data-bh-icon][data-state="error"] [data-bh-core] { background: linear-gradient(140deg, #8b93a7, #4a5364); box-shadow: none; animation: none; }
[data-bh-icon][data-state="error"] [data-bh-ring] { animation: none; opacity: 0.35; }
[data-bh-icon][data-tick="true"] { animation: bh-tick 700ms ease-out; }

/* ---------- readout ---------- */
[data-bh-text] { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.05; min-width: 0; }
[data-bh-value] {
  display: flex; align-items: baseline; gap: 4px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  letter-spacing: 0.01em;
  font-size: 18px;
  background: linear-gradient(92deg, #ffffff, var(--bh-cyan) 55%, var(--bh-violet));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  white-space: nowrap;
}
[data-bh-symbol] { font-size: 13px; opacity: 0.85; }
[data-bh-cur] { font-size: 11px; opacity: 0.7; letter-spacing: 0.08em; }
[data-bh-sub] {
  margin-top: 3px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--dsw-alias-label-secondary, #93a4bd);
  white-space: nowrap;
}
[data-bh-dot] {
  display: inline-block;
  width: 5px; height: 5px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--bh-cyan);
  box-shadow: 0 0 6px var(--bh-cyan);
  vertical-align: middle;
  animation: bh-blink 2.4s ease-in-out infinite;
}
[data-bh-sub][data-state="error"] [data-bh-dot] { background: var(--bh-crimson); box-shadow: 0 0 6px var(--bh-crimson); }
[data-bh-sub][data-state="warn"] [data-bh-dot] { background: var(--bh-amber); box-shadow: 0 0 6px var(--bh-amber); }

/* scanlines: a little holographic texture */
[data-bh-scan] {
  position: absolute; inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.045) 0 1px, transparent 1px 3px);
  mix-blend-mode: overlay;
  opacity: 0.5;
}

/* ---------- holographic panel ---------- */
[data-bh-panel] {
  position: absolute;
  right: 0; bottom: calc(100% + 12px);
  width: 336px;
  padding: 16px 18px 14px;
  z-index: 60;
  color: #e6f6ff;
  border-radius: 14px;
  background:
    radial-gradient(130% 120% at 0% 0%, rgba(160, 107, 255, 0.18), transparent 60%),
    radial-gradient(120% 130% at 100% 100%, rgba(53, 230, 255, 0.16), transparent 62%),
    linear-gradient(160deg, rgba(10, 20, 38, 0.97), rgba(7, 11, 24, 0.97));
  box-shadow:
    inset 0 0 0 1px rgba(53, 230, 255, 0.3),
    inset 0 0 26px rgba(53, 230, 255, 0.09),
    0 18px 44px rgba(0, 0, 0, 0.55),
    0 0 22px rgba(53, 230, 255, 0.16);
  clip-path: polygon(0 10px, 10px 0, calc(100% - 10px) 0, 100% 10px, 100% calc(100% - 10px), calc(100% - 10px) 100%, 10px 100%, 0 calc(100% - 10px));
  overflow: hidden;
  animation: bh-rise 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
[data-bh-head] { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
[data-bh-title] {
  display: flex; align-items: center; gap: 7px;
  font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;
  color: #9fe9ff;
}
[data-bh-refresh] {
  border: 0; background: transparent; cursor: pointer;
  color: #9fe9ff; font-size: 12px; letter-spacing: 0.12em;
  padding: 4px 8px; border-radius: 6px;
  transition: background 160ms ease, color 160ms ease;
}
[data-bh-refresh]:hover { background: rgba(53, 230, 255, 0.14); color: #fff; }
[data-bh-refresh]:disabled { opacity: 0.45; cursor: default; }

[data-bh-hero] { display: flex; align-items: baseline; gap: 7px; margin: 12px 0 3px; }
[data-bh-hero-num] {
  font-variant-numeric: tabular-nums;
  font-size: 40px; font-weight: 700; letter-spacing: 0.01em;
  background: linear-gradient(94deg, #ffffff, var(--bh-cyan) 52%, var(--bh-violet));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
[data-bh-hero-cur] { font-size: 15px; letter-spacing: 0.1em; color: #9fe9ff; }
[data-bh-status] { font-size: 12px; letter-spacing: 0.08em; color: var(--dsw-alias-label-secondary, #93a4bd); }
[data-bh-status][data-state="error"] { color: #ff8f9f; }

[data-bh-split] { height: 1px; margin: 12px 0 10px; background: linear-gradient(90deg, transparent, rgba(53, 230, 255, 0.4), transparent); }
[data-bh-rows] { display: flex; flex-direction: column; gap: 8px; }
[data-bh-row] { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
[data-bh-row] span:first-child { color: var(--dsw-alias-label-secondary, #93a4bd); letter-spacing: 0.06em; }
[data-bh-row] span:last-child { font-variant-numeric: tabular-nums; color: #dff6ff; }
[data-bh-bar] { position: relative; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
[data-bh-bar] i { position: absolute; inset: 0 auto 0 0; border-radius: 3px; }
[data-bh-bar][data-kind="granted"] i { background: linear-gradient(90deg, var(--bh-violet), #d0b3ff); box-shadow: 0 0 8px rgba(160, 107, 255, 0.7); }
[data-bh-bar][data-kind="topped"] i { background: linear-gradient(90deg, var(--bh-cyan), #b6f2ff); box-shadow: 0 0 8px rgba(53, 230, 255, 0.7); }
[data-bh-foot] { margin-top: 12px; font-size: 11px; letter-spacing: 0.06em; color: var(--dsw-alias-label-secondary, #93a4bd); display: flex; justify-content: space-between; gap: 8px; }

@keyframes bh-spin { to { transform: rotate(360deg); } }
@keyframes bh-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.86); opacity: 0.82; } }
@keyframes bh-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
@keyframes bh-tick { 0% { filter: brightness(2.4); transform: scale(1.1); } 100% { filter: brightness(1); transform: scale(1); } }
@keyframes bh-rise { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  [data-bh-ring], [data-bh-core], [data-bh-dot], [data-bh-icon][data-tick="true"], [data-bh-panel] { animation: none; }
  [data-bh-root], [data-bh-text], [data-bh-gauge] { transition: none; }
}

/* ---------- drag & tuck ---------- */
/* The badge is grabbed with the pointer, so the browser must not claim the
   gesture for scrolling, and a drag must not select the readout. */
[data-bh-badge] { touch-action: none; user-select: none; -webkit-user-select: none; }
[data-bh-root][data-dragging="true"] [data-bh-badge] { cursor: grabbing; box-shadow: inset 0 0 0 1px rgba(53, 230, 255, 0.65), 0 0 18px rgba(53, 230, 255, 0.3); }
[data-bh-root][data-dragging="true"] [data-bh-panel] { pointer-events: none; }

/* Tucked: the readout and gauge fade out but keep their box, so the badge keeps
   its width and the slide stays smooth. Only the core stays on screen. */
[data-bh-text], [data-bh-gauge] { transition: opacity 240ms ease; }
[data-bh-root][data-collapsed="true"] [data-bh-text],
[data-bh-root][data-collapsed="true"] [data-bh-gauge] { opacity: 0; }
/* Tucking left leaves the badge's right end on screen, so mirror the row and
   keep the core — not the readout — in the visible sliver. */
[data-bh-root][data-edge="left"] [data-bh-badge] { flex-direction: row-reverse; }
[data-bh-root][data-collapsed="true"] [data-bh-badge] { cursor: pointer; box-shadow: inset 0 0 0 1px rgba(53, 230, 255, 0.45), 0 2px 12px rgba(0, 0, 0, 0.35); }

/* The tuck handle rides the badge's right edge and only shows on hover. */
[data-bh-collapse] {
  position: absolute;
  top: 50%;
  right: -8px;
  transform: translateY(-50%);
  width: 16px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: rgba(10, 20, 38, 0.94);
  box-shadow: inset 0 0 0 1px rgba(53, 230, 255, 0.4);
  color: #9fe9ff;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.4;
  z-index: 70;
  transition: opacity 160ms ease, background 160ms ease;
}
/* Always dimly visible so it is discoverable (and reachable on touch, where
   there is no hover), then solid once the badge is hovered or focused. */
[data-bh-root]:hover [data-bh-collapse],
[data-bh-collapse]:focus-visible { opacity: 1; }
[data-bh-collapse]:hover { background: rgba(53, 230, 255, 0.22); color: #fff; }
`;

		/** Insert the stylesheet once, and only once per document. */
		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		function symbolOf(currency) {
			return SYMBOLS[currency] !== undefined ? SYMBOLS[currency] : "";
		}

		function formatAmount(value) {
			return Number.isFinite(value) ? value.toFixed(2) : "--";
		}

		function pad2(value) {
			return value < 10 ? "0" + String(value) : String(value);
		}

		/**
		 * localStorage is best-effort: private mode, a denied origin or a bare
		 * test harness must degrade to "no memory", never to a crash.
		 */
		function readStore(key, fallback) {
			try {
				const value = window.localStorage.getItem(key);
				return value === null || value === undefined ? fallback : value;
			} catch {
				return fallback;
			}
		}

		function writeStore(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch {
				/* the badge still works without persistence */
			}
		}

		/** Saved badge position, or null to let the stylesheet pick the corner. */
		function readPos() {
			const raw = readStore(POS_KEY, "");
			if (raw === "") return null;
			try {
				const parsed = JSON.parse(raw);
				if (parsed !== null && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
					return { x: parsed.x, y: parsed.y };
				}
			} catch {
				/* a corrupt entry simply falls back to the default corner */
			}
			return null;
		}

		/** Saved tuck edge, or null when the badge sits in the open. */
		function readTuck() {
			const saved = readStore(TUCK_KEY, "");
			if (EDGES.includes(saved)) return saved;
			// Older builds stored a right-only boolean; honour it once.
			if (saved === "" && readStore(LEGACY_COLLAPSE_KEY, "0") === "1") return "right";
			return null;
		}

		/** Which viewport edge the badge is closest to, and by how much. */
		function nearestEdgeOf(pos, width, height) {
			const gaps = [
				["left", pos.x],
				["right", viewportWidth() - (pos.x + width)],
				["top", pos.y],
				["bottom", viewportHeight() - (pos.y + height)],
			];
			let best = gaps[0];
			for (const entry of gaps) {
				if (entry[1] < best[1]) best = entry;
			}
			return best;
		}

		function viewportWidth() {
			return typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
		}

		function viewportHeight() {
			return typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
		}

		function clockOf(ms) {
			if (!ms) return "--:--:--";
			const date = new Date(ms);
			return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
		}

		/** Balance band: healthy / low / critical. */
		function stateOf(value) {
			if (!Number.isFinite(value)) return "error";
			if (value <= DANGER_AT) return "danger";
			if (value <= WARN_AT) return "warn";
			return "ok";
		}

		/** Ease a rendered number toward its target so a refresh is visible. */
		function useCountUp(target) {
			const [shown, setShown] = useState(target);
			const latest = useRef(target);
			latest.current = shown;
			useEffect(() => {
				if (!Number.isFinite(target) || !Number.isFinite(latest.current)) {
					setShown(target);
					return undefined;
				}
				const from = latest.current;
				if (from === target) return undefined;
				let frame = 0;
				const startedAt = Date.now();
				const duration = 650;
				const step = () => {
					const progress = Math.min(1, (Date.now() - startedAt) / duration);
					const eased = 1 - Math.pow(1 - progress, 3);
					setShown(from + (target - from) * eased);
					if (progress < 1) frame = globalThis.requestAnimationFrame(step);
				};
				frame = globalThis.requestAnimationFrame(step);
				return () => globalThis.cancelAnimationFrame(frame);
			}, [target]);
			return shown;
		}

		/** The badge, its poll loop, and its panel. */
		function BalanceCore(props) {
			const [open, setOpen] = useState(false);
			const [data, setData] = useState(null);
			const [error, setError] = useState(null);
			const [pending, setPending] = useState(true);
			const [tick, setTick] = useState(0);
			const rootRef = useRef(null);
			const badgeRef = useRef(null);
			const drag = useRef(null);
			const suppressUntil = useRef(0);
			const [pos, setPos] = useState(readPos);
			const [tuck, setTuck] = useState(readTuck);
			const collapsed = tuck !== null;
			const [dragging, setDragging] = useState(false);
			/** Last measured badge box: the tuck offset is computed in pixels. */
			const [size, setSize] = useState({ width: 220, height: 60 });

			/** Keep the badge fully inside the viewport, measured on the badge
			 *  itself so an open panel does not inflate the bounds. */
			const clampPos = useCallback((x, y) => {
				const el = badgeRef.current;
				const rect = el !== null && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
				const width = rect !== null && rect.width > 0 ? rect.width : 220;
				const height = rect !== null && rect.height > 0 ? rect.height : 60;
				const maxX = Math.max(EDGE, viewportWidth() - width - EDGE);
				const maxY = Math.max(EDGE, viewportHeight() - height - EDGE);
				return { x: Math.min(Math.max(x, EDGE), maxX), y: Math.min(Math.max(y, EDGE), maxY) };
			}, []);

			/** Tuck the badge into one edge; the visible sliver brings it back. */
			const tuckTo = useCallback((edge) => {
				if (!EDGES.includes(edge)) return;
				setOpen(false);
				const el = badgeRef.current;
				const rect = el !== null && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
				// Freeze the box the slide starts from, so the pixel offset is exact.
				if (rect !== null && rect.width > 0 && rect.height > 0) {
					setSize({ width: rect.width, height: rect.height });
				}
				setPos((current) => {
					if (current !== null) return current;
					return {
						x: rect !== null ? Math.round(rect.left) : Math.max(EDGE, viewportWidth() - 210),
						y: rect !== null ? Math.round(rect.top) : Math.max(EDGE, viewportHeight() - 198),
					};
				});
				setTuck(edge);
				writeStore(TUCK_KEY, edge);
				writeStore(LEGACY_COLLAPSE_KEY, "1");
			}, []);

			const expand = useCallback(() => {
				setTuck(null);
				writeStore(TUCK_KEY, "");
				writeStore(LEGACY_COLLAPSE_KEY, "0");
			}, []);

			/** Tuck into whichever edge the badge is currently hugging. */
			const tuckNearest = useCallback(() => {
				const el = badgeRef.current;
				const rect = el !== null && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
				const anchor = pos !== null ? pos : rect !== null ? { x: rect.left, y: rect.top } : { x: EDGE, y: Math.max(EDGE, viewportHeight() - 198) };
				const width = rect !== null && rect.width > 0 ? rect.width : 220;
				const height = rect !== null && rect.height > 0 ? rect.height : 60;
				tuckTo(nearestEdgeOf(anchor, width, height)[0]);
			}, [pos, tuckTo]);

			const onPointerDown = useCallback(
				(event) => {
					if (collapsed) return; // a tucked badge opens on click, it does not drag
					if (typeof event.button === "number" && event.button !== 0) return;
					const el = badgeRef.current;
					if (el === null || typeof el.getBoundingClientRect !== "function") return;
					const rect = el.getBoundingClientRect();
					drag.current = {
						id: event.pointerId,
						startX: event.clientX,
						startY: event.clientY,
						originX: rect.left,
						originY: rect.top,
						width: rect.width > 0 ? rect.width : 220,
						height: rect.height > 0 ? rect.height : 60,
						moved: false,
						last: null,
					};
					if (typeof event.currentTarget?.setPointerCapture === "function") {
						try {
							event.currentTarget.setPointerCapture(event.pointerId);
						} catch {
							/* capture is a nicety; the drag works without it */
						}
					}
				},
				[collapsed]
			);

			const onPointerMove = useCallback(
				(event) => {
					const state = drag.current;
					if (state === null || state.id !== event.pointerId) return;
					const dx = event.clientX - state.startX;
					const dy = event.clientY - state.startY;
					if (state.moved === false && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
					state.moved = true;
					const next = clampPos(state.originX + dx, state.originY + dy);
					state.last = next;
					setDragging(true);
					setPos(next);
					if (typeof event.preventDefault === "function") event.preventDefault();
				},
				[clampPos]
			);

			const finishDrag = useCallback(
				(event) => {
					const state = drag.current;
					if (state === null) return;
					if (event !== undefined && state.id !== event.pointerId) return;
					drag.current = null;
					setDragging(false);
					if (state.moved && state.last !== null) {
						// The click that follows a drag must not also toggle the panel.
						suppressUntil.current = Date.now() + CLICK_GUARD_MS;
						writeStore(POS_KEY, JSON.stringify(state.last));
						// Releasing near an edge tucks the badge into that edge.
						const [edge, gap] = nearestEdgeOf(state.last, state.width, state.height);
						if (gap <= EDGE_SNAP) {
							setSize({ width: state.width, height: state.height });
							tuckTo(edge);
						}
					}
					if (typeof event?.currentTarget?.releasePointerCapture === "function") {
						try {
							event.currentTarget.releasePointerCapture(state.id);
						} catch {
							/* already released */
						}
					}
				},
				[tuckTo]
			);

			// Keep a dragged badge on screen when the window is resized.
			useEffect(() => {
				const onResize = () => {
					setPos((current) => (current === null ? current : clampPos(current.x, current.y)));
				};
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, [clampPos]);

			// A badge restored in the tucked state still needs a concrete y to hug.
			useEffect(() => {
				if (!collapsed || pos !== null) return undefined;
				const el = badgeRef.current;
				if (el === null || typeof el.getBoundingClientRect !== "function") return undefined;
				const rect = el.getBoundingClientRect();
				setPos({ x: Math.round(rect.left), y: Math.round(rect.top) });
				return undefined;
			}, [collapsed, pos]);

			// Keep the tuck offset exact while tucked: a balance that gains a digit
			// changes the badge's width, and a stale offset would shift the sliver.
			useEffect(() => {
				if (tuck === null) return undefined;
				const el = badgeRef.current;
				if (el === null || typeof el.getBoundingClientRect !== "function") return undefined;
				const rect = el.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0 && (Math.abs(rect.width - size.width) > 0.5 || Math.abs(rect.height - size.height) > 0.5)) {
					setSize({ width: rect.width, height: rect.height });
				}
				return undefined;
			}, [data, open, tuck, size.width, size.height]);

			// Collapse on an outside click or Escape.
			useEffect(() => {
				if (!open) return undefined;
				const onDown = (event) => {
					const root = rootRef.current;
					if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
					setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);

			const refresh = useCallback(async () => {
				setPending(true);
				try {
					const response = await fetch(ROUTE, { headers: { accept: "application/json" }, cache: "no-store" });
					if (!response.ok) throw new Error("HTTP " + response.status);
					const result = await response.json();
					if (result !== null && typeof result === "object" && result.ok === true) {
						setData(result);
						setError(null);
						setTick((value) => value + 1);
					} else {
						setError({ message: typeof result?.message === "string" ? result.message : "查询失败" });
					}
				} catch (thrown) {
					setError({ message: thrown instanceof Error ? thrown.message : String(thrown) });
				} finally {
					setPending(false);
				}
			}, []);

			useEffect(() => {
				void refresh();
				const stop = props.timer.interval(() => {
					void refresh();
				}, open ? ACTIVE_MS : IDLE_MS);
				return stop;
			}, [open, refresh]);

			const balances = data !== null && Array.isArray(data.balances) ? data.balances : [];
			const primary = balances.length > 0 ? balances[0] : null;
			const value = primary !== null && Number.isFinite(primary.total) ? primary.total : NaN;
			const shown = useCountUp(value);
			// A failed poll keeps the last known balance on screen (better than a
			// blank), but the core must say so: the reading is stale, not healthy.
			const stale = error !== null;
			const state = stale || primary === null ? "error" : stateOf(value);
			const gauge = Number.isFinite(value) ? Math.max(2, Math.min(100, (value / FULL_SCALE) * 100)) : 0;
			const symbol = primary !== null ? symbolOf(primary.currency) : "";
			const granted = primary !== null && Number.isFinite(primary.granted) ? primary.granted : 0;
			const topped = primary !== null && Number.isFinite(primary.toppedUp) ? primary.toppedUp : 0;
			const mix = granted + topped;
			const label = primary === null ? (error !== null ? "信号中断" : "同步中…") : "实时余额";

			const icon = h(
				"span",
				{ key: "icon", "data-bh-icon": "", "data-state": state, "data-tick": tick > 0 ? "true" : "false" },
				h("span", { key: "ring", "data-bh-ring": "" }),
				h("span", { key: "core", "data-bh-core": "" })
			);

			const badgeChildren = [icon];
			badgeChildren.push(
				h(
					"span",
					{ key: "text", "data-bh-text": "" },
					h(
						"span",
						{ "data-bh-value": "" },
						h("span", { "data-bh-symbol": "" }, symbol),
						h("span", null, primary !== null ? formatAmount(shown) : "--"),
						h("span", { "data-bh-cur": "" }, primary !== null ? primary.currency : "")
					),
					h(
						"span",
						{ "data-bh-sub": "", "data-state": state },
						h("span", { "data-bh-dot": "" }),
						label
					)
				)
			);
			badgeChildren.push(h("span", { key: "gauge", "data-bh-gauge": "" }, h("i", { style: { width: gauge + "%" } })));
			badgeChildren.push(h("span", { key: "scan", "data-bh-scan": "" }));

			const badge = h(
				"button",
				{
					type: "button",
					"data-bh-badge": "",
					ref: badgeRef,
					"aria-expanded": open,
					"aria-label":
						"DeepSeek 账户余额 " + (primary !== null ? symbol + formatAmount(value) + " " + primary.currency : label),
					title: collapsed
						? "点击展开余额"
						: primary !== null
							? "DeepSeek 余额 " + symbol + formatAmount(value) + " " + primary.currency + " · 可拖动"
							: label + " · 可拖动",
					onPointerDown,
					onPointerMove,
					onPointerUp: finishDrag,
					onPointerCancel: finishDrag,
					onClick: () => {
						// A drag ends with a click event; that one is not a toggle.
						// Consume the guard so the next real click still lands.
						if (Date.now() < suppressUntil.current) {
							suppressUntil.current = 0;
							return;
						}
						if (collapsed) {
							expand();
							return;
						}
						setOpen((previous) => !previous);
					},
				},
				badgeChildren
			);

			const panel = !open
				? null
				: h(
						"div",
						{ "data-bh-panel": "", role: "dialog", "aria-label": "DeepSeek 账户余额" },
						h(
							"div",
							{ "data-bh-head": "" },
							h("span", { "data-bh-title": "" }, h("span", { "data-bh-dot": "" }), "BALANCE CORE"),
							h(
								"button",
								{
									type: "button",
									"data-bh-refresh": "",
									disabled: pending,
									onClick: () => {
										void refresh();
									},
								},
								pending ? "SYNC…" : "↻ 刷新"
							)
						),
						h(
							"div",
							{ "data-bh-hero": "" },
							h("span", { "data-bh-hero-num": "" }, primary !== null ? formatAmount(shown) : "--"),
							h("span", { "data-bh-hero-cur": "" }, primary !== null ? symbol + " " + primary.currency : "")
						),
						h(
							"div",
							{ "data-bh-status": "", "data-state": primary === null ? "error" : "ok" },
							primary === null
								? error !== null
									? error.message
									: "正在接入能量核心…"
								: data.isAvailable === false
									? "账户余额不足，API 调用可能被拒绝"
									: "API 可用 · 状态正常"
						),
						h("div", { "data-bh-split": "" }),
						h(
							"div",
							{ "data-bh-rows": "" },
							h(
								"div",
								{ "data-bh-row": "" },
								h("span", null, "赠送余额"),
								h("span", null, symbol + granted.toFixed(2))
							),
							h(
								"div",
								{ "data-bh-bar": "", "data-kind": "granted" },
								h("i", { style: { width: (mix > 0 ? (granted / mix) * 100 : 0) + "%" } })
							),
							h(
								"div",
								{ "data-bh-row": "" },
								h("span", null, "充值余额"),
								h("span", null, symbol + topped.toFixed(2))
							),
							h(
								"div",
								{ "data-bh-bar": "", "data-kind": "topped" },
								h("i", { style: { width: (mix > 0 ? (topped / mix) * 100 : 0) + "%" } })
							)
						),
						h(
							"div",
							{ "data-bh-foot": "" },
							h("span", null, "上次同步 " + clockOf(data !== null ? data.at : 0)),
							h("span", null, (open ? ACTIVE_MS : IDLE_MS) / 1000 + "s 轮询")
						)
					);

			// The layout always stays at the remembered position; tucking only adds a
			// pixel translate, so the browser interpolates the slide itself (a
			// percentage translate would jump with the badge's own width).
			// `right`/`bottom` MUST stay `auto` next to an explicit `left`/`top`:
			// a fixed box with both pairs set and `width: auto` stretches the frame.
			let style;
			if (pos === null) {
				style = undefined;
			} else {
				let tx = 0;
				let ty = 0;
				if (tuck === "right") tx = viewportWidth() - SLIVER - pos.x;
				else if (tuck === "left") tx = SLIVER - (pos.x + size.width);
				else if (tuck === "top") ty = SLIVER - (pos.y + size.height);
				else if (tuck === "bottom") ty = viewportHeight() - SLIVER - pos.y;
				style = {
					left: pos.x + "px",
					top: pos.y + "px",
					right: "auto",
					bottom: "auto",
					transform: "translate(" + tx + "px, " + ty + "px)",
				};
			}

			const collapseButton = collapsed
				? null
				: h(
						"button",
						{
							type: "button",
							"data-bh-collapse": "",
							title: "收起到最近的一边",
							"aria-label": "收起到最近的一边",
							onClick: tuckNearest,
						},
						"›"
					);

			return h(
				"div",
				{
					"data-bh-root": "",
					ref: rootRef,
					"data-collapsed": collapsed ? "true" : "false",
					"data-edge": tuck === null ? "none" : tuck,
					"data-dragging": dragging ? "true" : "false",
					style,
				},
				badge,
				collapseButton,
				panel
			);
		}

		/** Browser services this bundle needs before it may mount. */
		const inject = ["slots", "timer", "locale"];

		/**
		 * Browser plugin body: claim one additive cell of the frame-wide overlay
		 * and pin it to the top-left corner.
		 *
		 * The overlay is the additive seat for a frame-wide surface: a fresh id is
		 * added beside the shipped entries rather than replacing them, and the
		 * layer is click-through so this entry opts back into pointer events only
		 * for itself.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const zh = { "action.label": "DeepSeek 余额" };
			ctx.effect(() => ctx.locale.register(NS, { zh }), "balance-hud: zh dictionary");

			ctx.effect(() => {
				ensureStyle();
				return () => {
					document.getElementById(STYLE_ID)?.remove();
				};
			}, "balance-hud: stylesheet");

			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "deepseek-balance-core",
						order: -10,
						label: () => "DeepSeek 余额",
					},
					() => h(BalanceCore, { timer: ctx.timer })
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		/** Lower-level surface for a mount harness. */
		exports.BalanceCore = BalanceCore;
		return module.exports;
	},
});
