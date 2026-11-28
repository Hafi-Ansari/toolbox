// The home page's background: thin streams that flow across the page and pinch together through
// the live demo panel, like files passing through the toolbox, with small glowing packets riding
// them. Drawn on one fixed canvas behind everything. Kept calm: low contrast, slow, it bends a
// little around the pointer, fades out as the page scrolls past the hero, stops drawing when
// unseen, and is a still frame for people who prefer reduced motion.
import { type RefObject, useEffect, useRef } from "react";
import s from "./Hero.module.css";

interface Stream {
	/** Resting height, as a fraction of the viewport. */
	y: number;
	amp: number;
	k1: number;
	k2: number;
	s1: number;
	s2: number;
	phase: number;
	alpha: number;
	packets: { u: number; speed: number }[];
}

/** Small seeded generator, so the layout is the same on every visit. */
function seeded(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeStreams(count: number): Stream[] {
	const r = seeded(7);
	return Array.from({ length: count }, (_, i) => ({
		y: (i + 0.5) / count,
		amp: 12 + r() * 26,
		k1: 0.0015 + r() * 0.002,
		k2: 0.004 + r() * 0.004,
		s1: 0.1 + r() * 0.16,
		s2: 0.07 + r() * 0.1,
		phase: r() * Math.PI * 2,
		alpha: 0.1 + r() * 0.12,
		packets: Array.from({ length: r() > 0.5 ? 2 : 1 }, () => ({ u: r(), speed: 0.025 + r() * 0.035 })),
	}));
}

/** A soft round glow, drawn once and stamped for every packet. */
function glowSprite(rgb: string): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = c.height = 48;
	const g = c.getContext("2d");
	if (g) {
		const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
		grad.addColorStop(0, `rgba(${rgb},1)`);
		grad.addColorStop(0.18, `rgba(${rgb},0.55)`);
		grad.addColorStop(1, `rgba(${rgb},0)`);
		g.fillStyle = grad;
		g.fillRect(0, 0, 48, 48);
	}
	return c;
}

function accentRgb(): string {
	const hex = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#00ed64";
	const n = Number.parseInt(hex.replace("#", ""), 16);
	return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

export function FlowLines({ focus }: { focus: RefObject<HTMLElement | null> }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const rgb = accentRgb();
		const glow = glowSprite(rgb);
		let w = 0;
		let h = 0;
		let streams: Stream[] = [];
		const pointer = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, strength: 0, target: 0 };

		const resize = () => {
			const dpr = Math.min(1.5, window.devicePixelRatio || 1);
			w = window.innerWidth;
			h = window.innerHeight;
			canvas.width = Math.round(w * dpr);
			canvas.height = Math.round(h * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			const count = w < 700 ? 7 : 11;
			if (streams.length !== count) streams = makeStreams(count);
			if (still) draw(0, 0);
		};

		const onPointer = (e: PointerEvent) => {
			if (e.pointerType !== "mouse") return;
			pointer.tx = e.clientX;
			pointer.ty = e.clientY;
			pointer.target = 1;
		};
		const onLeave = () => {
			pointer.target = 0;
		};

		function draw(t: number, dt: number) {
			if (!ctx) return;
			const fade = Math.max(0, Math.min(1, 1 - window.scrollY / (h * 0.85)));
			if (canvas) canvas.style.opacity = String(fade);
			if (fade === 0) return;

			// Streams pinch toward the demo panel's middle and pass behind it.
			const rect = focus.current?.getBoundingClientRect();
			const fx = rect ? rect.left + rect.width / 2 : w * 0.72;
			const fy = rect ? rect.top + rect.height / 2 : h * 0.42;
			const band = rect ? rect.height * 0.36 : 90;
			const reach = Math.max(260, w * 0.26);

			pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 6);
			pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 6);
			pointer.strength += (pointer.target - pointer.strength) * Math.min(1, dt * 2.5);
			pointer.target *= 0.985; // a still mouse lets the streams settle

			const yAt = (st: Stream, x: number) => {
				const base = h * 0.06 + st.y * h * 0.84;
				const pinch = Math.exp(-(((x - fx) / reach) ** 2));
				const anchor = base + (fy + (st.y - 0.5) * 2 * band - base) * pinch;
				const wave =
					(st.amp * Math.sin(x * st.k1 + t * st.s1 + st.phase) +
						st.amp * 0.5 * Math.sin(x * st.k2 - t * st.s2 + st.phase * 2)) *
					(1 - 0.75 * pinch);
				const dx = x - pointer.x;
				const dy = anchor - pointer.y;
				const bump = pointer.strength * 26 * Math.exp(-(dx * dx) / 28_800 - (dy * dy) / 16_200);
				return anchor + wave + (dy < 0 ? bump : -bump); // streams part around the pointer
			};

			ctx.clearRect(0, 0, w, h);
			ctx.lineWidth = 1.25;
			for (const st of streams) {
				ctx.strokeStyle = `rgba(${rgb},${st.alpha})`;
				ctx.beginPath();
				for (let x = -20; x <= w + 20; x += 14) {
					const y = yAt(st, x);
					if (x === -20) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				}
				ctx.stroke();
				for (const p of st.packets) {
					p.u = (p.u + p.speed * dt) % 1;
					const x = p.u * (w + 80) - 40;
					const y = yAt(st, x);
					// Packets brighten as they pass through the panel's band, then dim again.
					const near = Math.exp(-(((x - fx) / reach) ** 2));
					ctx.globalAlpha = Math.min(1, st.alpha * 6 + near * 0.25);
					const size = 10 + near * 6;
					ctx.drawImage(glow, x - size, y - size, size * 2, size * 2);
				}
				ctx.globalAlpha = 1;
			}
		}

		const onScroll = () => draw(0, 0);
		let frame = 0;
		let last = performance.now();
		const loop = (now: number) => {
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			draw(now / 1000, dt);
			frame = requestAnimationFrame(loop);
		};

		resize();
		window.addEventListener("resize", resize);
		if (!still) {
			window.addEventListener("pointermove", onPointer, { passive: true });
			document.addEventListener("pointerleave", onLeave);
			frame = requestAnimationFrame(loop);
		} else {
			window.addEventListener("scroll", onScroll, { passive: true });
		}
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", resize);
			window.removeEventListener("pointermove", onPointer);
			document.removeEventListener("pointerleave", onLeave);
		};
	}, [focus]);

	return <canvas ref={canvasRef} className={s.flow} />;
}
