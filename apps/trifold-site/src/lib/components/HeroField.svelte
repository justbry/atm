<script lang="ts">
	/**
	 * The hero field (brand guide §5). A static final frame (the sealed month) paints first and stays for reduced motion;
	 * the canvas plays the storyboard once over it and hands back to the static frame at the end. Positions are a pure
	 * function of the elapsed time, so pausing (offscreen, hidden tab) is just not advancing the clock.
	 *
	 * F1 stream · F2 books (pairs + lines) · F3 receipts (green flares) · F4 proof sweep, 212/214 → 214/214 · F5 fold to
	 * the seal. No loop, no witness halo.
	 */
	import { onMount } from "svelte";

	type Phase = "rest" | "events" | "books" | "receipts" | "matching" | "matched" | "sealed";

	let { phase = $bindable<Phase>("sealed") }: { phase?: Phase } = $props();

	const LABELS: Record<Phase, string> = {
		rest: "OCTOBER 2026 · SEALED",
		events: "STRIPE EVENTS · 214",
		books: "BOOKS · BALANCED",
		receipts: "RECEIPTS · 214 SIGNED",
		matching: "STRIPE · 212/214 MATCHED",
		matched: "STRIPE · 214/214 MATCHED",
		sealed: "OCTOBER 2026 · SEALED",
	};

	// Storyboard times, seconds from start.
	const T = {
		streamIn: 0.8,
		pair: 2.5,
		receipts: 4.0,
		sweep: 5.5,
		resolve: 6.35,
		compress: 7.0,
		fold: 7.75,
		handoff: 8.35,
		end: 9.3,
	} as const;

	const DPR_CAP = 1.5;
	const SPRITE = 64;
	/** The two receipts that stay clay for a beat during the sweep, then resolve. */
	const UNMATCHED = [37, 111];
	/** "Your" dollar: one pair drawn brighter throughout. */
	const YOURS = 52;

	let field: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	let playing = $state(false);
	let done = $state(false);
	let label = $derived(LABELS[phase]);

	const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
	const easeOut = (value: number) => 1 - (1 - clamp01(value)) ** 3;
	const easeInOut = (value: number) => {
		const x = clamp01(value);
		return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
	};
	const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

	const phaseAt = (t: number): Phase => {
		if (t < T.streamIn) return "rest";
		if (t < T.pair + 0.3) return "events";
		if (t < T.receipts + 0.2) return "books";
		if (t < T.sweep) return "receipts";
		if (t < T.resolve) return "matching";
		if (t < T.compress + 0.2) return "matched";
		return "sealed";
	};

	onMount(() => {
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (reduced) return;
		const context = canvas.getContext("2d");
		if (!context) return;
		const ctx = context;

		// Seeded, so every visit sees the same picture.
		let seed = 214;
		const random = () => {
			seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
			return seed / 2 ** 32;
		};

		let width = 0;
		let height = 0;
		let compact = false;
		let pairs = 150;
		let columns = 6;

		type Pair = { u: number; v: number; u2: number; v2: number; speed: number; drift: number; delay: number };
		let pairList: Pair[] = [];
		const makePairs = () => {
			seed = 214;
			pairList = Array.from({ length: pairs }, () => ({
				u: random(),
				v: random(),
				u2: random(),
				v2: random(),
				speed: 0.05 + random() * 0.07,
				drift: random() * Math.PI * 2,
				delay: random() * 0.35,
			}));
		};

		type Palette = { dim: string; proof: string; alert: string; seal: string; line: string; dark: boolean };
		let palette: Palette;
		let sprites: Record<"dim" | "proof" | "alert" | "seal" | "halo", HTMLCanvasElement>;

		const readPalette = (): Palette => {
			const style = getComputedStyle(document.documentElement);
			const dark = document.documentElement.classList.contains("dark");
			// Fallbacks keep the canvas drawing if a token is ever missing; a bad color must never break the page.
			const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
			return {
				dim: dark ? "#b9c1d4" : get("--muted-foreground", "#5b6680"),
				proof: get("--proof", "#5be3a1"),
				alert: get("--alert", "#e07a5f"),
				seal: get("--seal", "#f2b447"),
				line: dark ? "rgba(233,236,244,0.09)" : "rgba(22,32,58,0.12)",
				dark,
			};
		};

		/** A pre-rendered dot: soft light in dark mode, an ink dot with a slight bleed in light mode. */
		const sprite = (color: string, dark: boolean) => {
			const off = document.createElement("canvas");
			off.width = SPRITE;
			off.height = SPRITE;
			const g = off.getContext("2d") as CanvasRenderingContext2D;
			const r = SPRITE / 2;
			const gradient = g.createRadialGradient(r, r, 0, r, r, r);
			if (dark) {
				gradient.addColorStop(0, "#ffffff");
				gradient.addColorStop(0.12, color);
				gradient.addColorStop(0.32, `${color}88`);
				gradient.addColorStop(1, `${color}00`);
			} else {
				gradient.addColorStop(0, color);
				gradient.addColorStop(0.3, color);
				gradient.addColorStop(0.42, `${color}66`);
				gradient.addColorStop(0.55, `${color}00`);
			}
			g.fillStyle = gradient;
			g.fillRect(0, 0, SPRITE, SPRITE);
			return off;
		};

		/** The seal's gathering glow: saffron only, no white core, fading to nothing well inside its box. */
		const halo = (color: string) => {
			const off = document.createElement("canvas");
			off.width = SPRITE * 2;
			off.height = SPRITE * 2;
			const g = off.getContext("2d") as CanvasRenderingContext2D;
			const r = SPRITE;
			const gradient = g.createRadialGradient(r, r, 0, r, r, r);
			gradient.addColorStop(0, `${color}aa`);
			gradient.addColorStop(0.35, `${color}44`);
			gradient.addColorStop(1, `${color}00`);
			g.fillStyle = gradient;
			g.fillRect(0, 0, r * 2, r * 2);
			return off;
		};

		const refreshTheme = () => {
			palette = readPalette();
			sprites = {
				dim: sprite(palette.dim, palette.dark),
				proof: sprite(palette.proof, palette.dark),
				alert: sprite(palette.alert, palette.dark),
				seal: sprite(palette.seal, palette.dark),
				halo: halo(palette.seal),
			};
		};

		const resize = () => {
			const box = field.getBoundingClientRect();
			width = box.width;
			height = box.height;
			const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			const nextCompact = width < 520;
			if (nextCompact !== compact || pairList.length === 0) {
				compact = nextCompact;
				pairs = compact ? 90 : 150;
				columns = compact ? 5 : 6;
				makePairs();
			}
		};

		// ---- geometry ----
		const layout = () => {
			const rows = Math.ceil(pairs / columns);
			const blockWidth = Math.min(width * 0.17, 150);
			const top = height * 0.2;
			const bottom = height * 0.84;
			return {
				rows,
				blockWidth,
				top,
				rowGap: (bottom - top) / (rows - 1),
				colGap: blockWidth / (columns - 1),
				centers: [width * 0.22, width * 0.5, width * 0.78] as const,
			};
		};

		const slot = (block: 0 | 1 | 2, k: number, geo: ReturnType<typeof layout>) => {
			const col = k % columns;
			const row = Math.floor(k / columns);
			return {
				x: geo.centers[block] - geo.blockWidth / 2 + col * geo.colGap,
				y: geo.top + row * geo.rowGap,
			};
		};

		const stream = (pair: Pair, second: boolean, t: number) => {
			const u = second ? pair.u2 : pair.u;
			const v = second ? pair.v2 : pair.v;
			const elapsed = Math.max(0, t - T.streamIn);
			const fall = (v + elapsed * pair.speed) % 1;
			return {
				x: width * 0.5 + (u - 0.5) * width * 0.62 + Math.sin(elapsed * 0.9 + pair.drift) * 6,
				y: height * (0.04 + fall * 0.92),
			};
		};

		/** The seal triangle, sized like the static frame: circumradius 30% of the field's shorter side. */
		const triangle = () => {
			const side = Math.min(width, height);
			const radius = side * 0.3;
			const cx = width / 2;
			const cy = height / 2;
			const half = radius * Math.sin(Math.PI / 3);
			return {
				cx,
				cy,
				radius,
				edge: half * 2,
				left: { x: cx - half, y: cy + radius / 2 },
				right: { x: cx + half, y: cy + radius / 2 },
			};
		};

		/** F5: a point at `s` (0–1) on the bar, folded by `fold` (0–1) into the triangle (the logo gesture). */
		const folded = (s: number, fold: number, tri: ReturnType<typeof triangle>) => {
			const length = tri.edge * 3;
			if (s >= 1 / 3 && s <= 2 / 3) return { x: tri.left.x + (s - 1 / 3) * length, y: tri.left.y };
			if (s < 1 / 3) {
				const distance = (1 / 3 - s) * length;
				const angle = Math.PI + (fold * 2 * Math.PI) / 3;
				return { x: tri.left.x + distance * Math.cos(angle), y: tri.left.y + distance * Math.sin(angle) };
			}
			const distance = (s - 2 / 3) * length;
			const angle = -(fold * 2 * Math.PI) / 3;
			return { x: tri.right.x + distance * Math.cos(angle), y: tri.right.y + distance * Math.sin(angle) };
		};

		const dot = (
			image: HTMLCanvasElement,
			x: number,
			y: number,
			size: number,
			alpha: number,
		) => {
			if (alpha <= 0.002) return;
			ctx.globalAlpha = Math.min(1, alpha);
			ctx.drawImage(image, x - size / 2, y - size / 2, size, size);
		};

		const draw = (t: number) => {
			ctx.clearRect(0, 0, width, height);
			if (t < T.streamIn) return;
			const geo = layout();
			const tri = triangle();
			const dark = palette.dark;
			const base = dark ? (compact ? 9 : 11) : compact ? 5 : 6;
			const fadeIn = easeOut((t - T.streamIn) / 0.8);
			const sweepX = lerp(-0.1 * width, 1.1 * width, clamp01((t - T.sweep) / 0.9));
			const sweepOn = t >= T.sweep && t <= T.sweep + 1.0;
			const compress = easeInOut((t - T.compress) / 0.75);
			const fold = easeInOut((t - T.fold) / 0.65);
			const handoff = clamp01((t - T.handoff) / 0.8);
			const total = pairs * 3;

			// Positions of each pair's three points.
			const points: { x: number; y: number }[][] = [];
			for (let k = 0; k < pairs; k++) {
				const pair = pairList[k] as Pair;
				const row = Math.floor(k / columns);
				const pairing = easeInOut((t - T.pair - pair.delay) / 1.1);
				const debitSlot = slot(0, k, geo);
				const creditSlot = slot(1, k, geo);
				const receiptSlot = slot(2, k, geo);
				const debitStream = stream(pair, false, Math.min(t, T.pair + pair.delay));
				const creditStream = stream(pair, true, Math.min(t, T.pair + pair.delay));
				let debit = { x: lerp(debitStream.x, debitSlot.x, pairing), y: lerp(debitStream.y, debitSlot.y, pairing) };
				let credit = { x: lerp(creditStream.x, creditSlot.x, pairing), y: lerp(creditStream.y, creditSlot.y, pairing) };
				const peel = easeOut((t - T.receipts - row * 0.04) / 0.7);
				let receipt = { x: lerp(creditSlot.x, receiptSlot.x, peel), y: lerp(creditSlot.y, receiptSlot.y, peel) };
				if (compress > 0) {
					const place = (index: number, from: { x: number; y: number }) => {
						const s = index / total;
						const bar = folded(s, 0, tri);
						const target = fold > 0 ? folded(s, fold, tri) : bar;
						return { x: lerp(from.x, target.x, compress), y: lerp(from.y, target.y, compress) };
					};
					// Interleave the three columns along the bar so each third holds all three records.
					debit = place(k * 3, debit);
					credit = place(k * 3 + 1, credit);
					receipt = place(k * 3 + 2, receipt);
				}
				points.push([debit, credit, receipt]);
			}

			// Hairlines joining each debit to its credit: the books balance.
			const lineAlpha = clamp01((t - T.pair - 0.6) / 0.9) * (1 - compress);
			if (lineAlpha > 0) {
				ctx.globalAlpha = lineAlpha;
				ctx.globalCompositeOperation = "source-over";
				ctx.strokeStyle = palette.line;
				ctx.lineWidth = 1;
				ctx.beginPath();
				for (const [debit, credit] of points) {
					ctx.moveTo((debit as { x: number }).x, (debit as { y: number }).y);
					ctx.lineTo((credit as { x: number }).x, (credit as { y: number }).y);
				}
				ctx.stroke();
			}

			ctx.globalCompositeOperation = dark ? "lighter" : "multiply";
			const fadeOut = 1 - handoff;
			for (let k = 0; k < pairs; k++) {
				const [debit, credit, receipt] = points[k] as { x: number; y: number }[];
				const row = Math.floor(k / columns);
				const yours = k === YOURS;
				const boost = yours ? 1.7 : 1;
				const sealMix = clamp01((t - T.compress - 0.2) / 0.8);
				const sweepNear = (x: number) => (sweepOn ? Math.max(0, 1 - Math.abs(x - sweepX) / 40) : 0);
				const pointAlpha = (dark ? 0.42 : 0.55) * fadeIn * fadeOut * (yours ? 1.6 : 1);

				for (const point of [debit, credit] as { x: number; y: number }[]) {
					const near = sweepNear(point.x);
					dot(sprites.dim, point.x, point.y, base * boost * (1 + near * 0.6), (pointAlpha + near * 0.4) * (1 - sealMix));
					dot(sprites.seal, point.x, point.y, base * boost, pointAlpha * 1.4 * sealMix);
				}

				// Receipts appear as they peel off, flaring green on arrival.
				const arrive = T.receipts + row * 0.04 + 0.55;
				if (t >= T.receipts + row * 0.04) {
					const flare = t >= arrive ? Math.exp(-(t - arrive) * 3.2) : 0;
					const unmatched = UNMATCHED.includes(k) && t >= T.sweep && t < T.resolve;
					const justResolved = UNMATCHED.includes(k) && t >= T.resolve ? Math.exp(-(t - T.resolve) * 3) : 0;
					const near = sweepNear(receipt.x);
					const size = base * boost * (1.15 + flare * 1.4 + near * 0.7 + justResolved * 1.6);
					const alpha = ((dark ? 0.6 : 0.75) + flare * 0.4 + near * 0.3) * fadeOut * (yours ? 1.3 : 1);
					const image = unmatched ? sprites.alert : sprites.proof;
					dot(image, receipt.x, receipt.y, unmatched ? size * 1.5 : size, alpha * (1 - sealMix));
					dot(sprites.seal, receipt.x, receipt.y, base * boost, alpha * sealMix);
				}
			}

			// The proof sweep: a soft, elliptical band crossing all three columns once.
			if (sweepOn) {
				ctx.globalCompositeOperation = dark ? "lighter" : "multiply";
				const tint = dark ? "91,227,161" : "47,125,91";
				const reach = height * 0.42;
				ctx.save();
				ctx.translate(sweepX, height * 0.52);
				ctx.scale(1, reach / 60);
				const band = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
				band.addColorStop(0, `rgba(${tint},${dark ? 0.13 : 0.1})`);
				band.addColorStop(1, `rgba(${tint},0)`);
				ctx.globalAlpha = 1;
				ctx.fillStyle = band;
				ctx.fillRect(-60, -60, 120, 120);
				ctx.restore();
			}

			// The seal's glow gathers as the fold closes, so the hand-off to the static frame is seamless.
			if (fold > 0.5 && dark) {
				ctx.globalCompositeOperation = "lighter";
				const glow = clamp01((fold - 0.5) * 2) * (1 - handoff);
				dot(sprites.halo, tri.cx, tri.cy, Math.min(width, height) * 0.95, glow * 0.9);
			}
			ctx.globalAlpha = 1;
			ctx.globalCompositeOperation = "source-over";
		};

		try {
			refreshTheme();
			resize();
		} catch {
			return; // No animation; the static sealed frame stays.
		}

		let elapsed = 0;
		let last = 0;
		let frame = 0;
		let visible = true;
		let finished = false;

		const loop = (now: number) => {
			frame = 0;
			const running = visible && document.visibilityState === "visible";
			if (running) {
				elapsed += last ? Math.min(now - last, 50) / 1000 : 0;
				last = now;
			} else {
				last = 0;
				return;
			}
			const next = phaseAt(elapsed);
			if (next !== phase) phase = next;
			if (elapsed >= T.handoff && playing) playing = false;
			draw(elapsed);
			if (elapsed >= T.end) {
				finished = true;
				done = true;
				phase = "sealed";
				ctx.clearRect(0, 0, width, height);
				return;
			}
			frame = requestAnimationFrame(loop);
		};

		const start = () => {
			if (finished || frame) return;
			last = 0;
			frame = requestAnimationFrame(loop);
		};

		const observer = new IntersectionObserver((entries) => {
			visible = entries.some((entry) => entry.isIntersecting);
			if (visible) start();
		});
		observer.observe(field);
		const onVisibility = () => {
			if (document.visibilityState === "visible") start();
		};
		document.addEventListener("visibilitychange", onVisibility);
		const sizeObserver = new ResizeObserver(() => {
			resize();
			if (!frame && !finished) draw(elapsed);
		});
		sizeObserver.observe(field);
		const themeObserver = new MutationObserver(() => {
			refreshTheme();
			if (!frame && !finished) draw(elapsed);
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

		phase = "rest";
		playing = true;
		start();

		return () => {
			observer.disconnect();
			sizeObserver.disconnect();
			themeObserver.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			cancelAnimationFrame(frame);
		};
	});
</script>

<div
	class="field"
	data-agent="skip"
	class:playing
	class:done
	bind:this={field}
	role="img"
	aria-label="Illustration: 214 Stripe events become balanced books, 214 signed receipts, 214 of 214 matched to Stripe, and one sealed month."
>
	<div class="final" aria-hidden="true">
		<div class="square">
			<div class="glow seal-surface"></div>
			<div class="facet a "></div>
			<div class="facet b "></div>
			<div class="facet c "></div>
			<svg class="folds" viewBox="0 0 100 100" preserveAspectRatio="none">
				<path d="M50 50 L50 20 M50 50 L24.02 65 M50 50 L75.98 65" />
			</svg>
		</div>
		<div class="baseline num">
			<span>214 EVENTS</span><span class="sep">·</span><span>BOOKS ✓</span><span class="sep">·</span><span
				>RECEIPTS ✓</span
			><span class="sep">·</span><span>STRIPE ✓</span>
		</div>
	</div>
	<canvas bind:this={canvas} aria-hidden="true"></canvas>
	<div class="frame-label num" aria-hidden="true" data-phase={phase}>
		<span class="dot"></span>{label}
	</div>
</div>

<style>
	.field {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 340px;
		container-type: size;
		isolation: isolate;
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		transition: opacity 0.9s var(--ease-brand);
		pointer-events: none;
	}
	.final {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		transition: opacity 0.9s var(--ease-brand);
	}
	.playing canvas {
		opacity: 1;
	}
	.playing .final {
		opacity: 0;
		transition-duration: 0.5s;
	}
	.done canvas {
		opacity: 0;
	}
	.square {
		position: relative;
		width: min(100cqw, 100cqh);
		aspect-ratio: 1;
	}
	.facet {
		position: absolute;
		inset: 0;
	}
	.facet.a {
		clip-path: polygon(50% 50%, 50% 20%, 24.02% 65%);
		background: var(--seal);
	}
	.facet.b {
		clip-path: polygon(50% 50%, 24.02% 65%, 75.98% 65%);
		background: color-mix(in srgb, var(--seal) 74%, var(--background));
	}
	.facet.c {
		clip-path: polygon(50% 50%, 75.98% 65%, 50% 20%);
		background: color-mix(in srgb, var(--seal) 52%, var(--background));
	}
	/* Light mode: saffron foil. Each facet takes the light at its own angle; the angle follows scroll (see foil.ts). */
	:global(:root:not(.dark)) .facet {
		--foil-stops: #a8701a 0%, #e9c46a 26%, #fff3cc 42%, #d9a23a 58%, #b47c20 78%, #e6ba58 100%;
	}
	:global(:root:not(.dark)) .facet.a {
		background: linear-gradient(var(--foil-angle), var(--foil-stops));
	}
	:global(:root:not(.dark)) .facet.b {
		background: linear-gradient(calc(var(--foil-angle) + 50deg), var(--foil-stops));
		filter: brightness(0.9);
	}
	:global(:root:not(.dark)) .facet.c {
		background: linear-gradient(calc(var(--foil-angle) - 50deg), var(--foil-stops));
		filter: brightness(0.8);
	}
	.folds {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		fill: none;
		stroke: var(--background);
		stroke-width: 0.7;
		stroke-linecap: round;
	}
	.glow {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 34%;
		height: 34%;
		transform: translate(-50%, -50%);
	}
	:global(.dark) .glow::before {
		inset: -70% !important;
	}
	:global(:root:not(.dark)) .glow {
		display: none;
	}
	.baseline {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 6%;
		display: flex;
		justify-content: center;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 11px;
		letter-spacing: 0.14em;
		color: var(--muted-foreground);
	}
	.baseline .sep {
		color: var(--fg-dim);
	}
	.frame-label {
		position: absolute;
		top: 0;
		left: 0;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 8px 14px;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--background) 70%, transparent);
		font-size: 11.5px;
		letter-spacing: 0.14em;
		color: var(--foreground);
		white-space: nowrap;
	}
	.frame-label .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--muted-foreground);
		transition:
			background-color 0.4s var(--ease-brand),
			box-shadow 0.4s var(--ease-brand);
	}
	.frame-label[data-phase="receipts"] .dot,
	.frame-label[data-phase="matched"] .dot {
		background: var(--proof);
		box-shadow: var(--glow-proof);
	}
	.frame-label[data-phase="matching"] .dot {
		background: var(--alert);
	}
	.frame-label[data-phase="sealed"] .dot,
	.frame-label[data-phase="rest"] .dot {
		background: var(--seal);
		box-shadow: var(--glow-seal);
	}
	@media (prefers-contrast: more) {
		.frame-label {
			border-color: var(--foreground);
		}
	}
</style>
