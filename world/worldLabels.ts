/**
 * Names in the 3D world (2026-10-02): peaks, towers, places, streets, water -- drawn the way the
 * overlay bench draws a horizon's names, as slanted pills over their anchors (terrain/peakLabels
 * layoutSkyLabels), in SCREEN space at a constant size over the WebGL canvas. World-sized text was
 * unreadable at 100 km and clutter at 100 m.
 *
 * Where the names come from is the app's business (the workbench: the bench's pool round the
 * camera, the OSM map tiles' names, the per-solve map's names). This module takes a list of
 * `Named` in scene metres and decides where they go and which are hidden.
 *
 * WHAT IS HIDDEN is decided by the DEPTH BUFFER the frame was drawn with, as the bench decides it
 * against its render: a name is shown when nothing is drawn well in front of its own pixel, or --
 * the bench's height band, for peaks and places -- when ANY pixel row within 100 m above or below
 * it shows ground at the name's own distance (a town just behind a low rise still has its roofs in
 * view; the bench calls that seen too). Every row, as the bench scans every row of its column: on
 * a plain seen at a grazing angle the depth jumps kilometres from one row to the next, and a few
 * sampled heights stepped right over the window (Rozhledna Vinice: 33 of 106 agreed). See
 * `verdict`. So the terrain, the buildings and the point clouds hide names
 * exactly as they are drawn, and there is no second model of the scene to keep in step. The depth
 * is read by DepthProbe -- one point per name in a small float target, whose fragment shader walks
 * the depth texture up the name's band and writes the verdict -- and read back asynchronously, so a name appears or goes a frame or two late,
 * never as a stall. Where a name is (its pixel) is computed on the CPU every frame, so it never
 * swims behind the picture.
 *
 * The same RELIEF the vertex shader applies (relief.ts: height exaggeration and refraction) is
 * applied to every anchor here, by `relieved` -- or a peak's name would float off its peak the
 * moment relief is on.
 *
 * Order is the bench's editorial order (overlay_export / peakLabels): priority first -- prominence
 * for terrain, log-population for places -- then nearest; the layouter is first-come, so the best
 * name wins its neighbourhood. A notable place that is hidden (priority >= DIRECTION_MIN_PRIORITY,
 * within 100 km, behind something at least DIRECTION_MIN_OCCLUDER_M off) is drawn dim, after every
 * visible name: "it lies that way, behind this" -- and, as the bench draws it (labelPills), on the
 * RIDGE of what hides it, its leader stopping short of it: drawn at the place's own pixel, Dobříš
 * sat on Petřín's flank 3 km off and read as seen through the hill (2026-10-03).
 */
import type * as THREE_NS from 'three';
import {
	DIRECTION_MAX_DIST_M,
	DIRECTION_MIN_OCCLUDER_M,
	DIRECTION_MIN_PRIORITY,
	PLACE_KINDS,
	PLACE_MAX_DIST_M,
	layoutSkyLabels,
	type SkyLabel
} from '../terrain/peakLabels';
import type { Vec3 } from './geodesy';
import { relieved, type Relief } from './relief';

type Three = typeof THREE_NS;

/** the kinds the bench calls terrain: amber pills, the height band, tagged elevations in the text */
export const TERRAIN_KINDS = new Set(['peak', 'tower', 'mast']);

/** a name to draw: where (scene metres, as the viewer's scene holds it), and how it ranks */
export type Named = {
	id: string;
	name: string;
	kind: string;
	/** what the pill says */
	text: string;
	s: Vec3;
	priority: number;
	/** how strongly it is drawn (the map's names follow the map's strength); 1 if absent */
	alpha?: number;
};

/**
 * How far from the camera a kind is named at all, metres. The map's names (streets, water,
 * buildings) reach further by the view's magnification, `zoom` (worldLabels' zoomOf): through a
 * telephoto a street 10 km off is as legible as one 200 m off is to the eye -- up to the map tiles'
 * own reach. Peaks and places keep the bench's caps: their pool is what limits them.
 */
export function maxDistance(kind: string, zoom = 1): number {
	if (TERRAIN_KINDS.has(kind)) return 120_000;
	if (PLACE_KINDS.has(kind)) return PLACE_MAX_DIST_M[kind] ?? 120_000;
	const z = Math.max(1, zoom);
	if (kind === 'water') return Math.min(30_000, 3_000 * z);
	if (kind === 'building') return Math.min(30_000, 600 * z);
	return Math.min(30_000, 1_500 * z); // streets and paths
}

/**
 * How far from its anchor the drawn scene at a name's pixel may be and still count as the named
 * thing. Terrain and places: the bench's summit window exactly, 300 m + 3 % (overlay_export
 * SUMMIT_DEPTH_*): an OSM node against a DEM's rendered top, and a village is an AREA round its
 * node -- the bench calls Horin seen from Melnik with ground 212 m in front of the node at 900 m.
 * (A tighter near-field cap, tried first, hid 27 of the 117 names the bench sees there.) Streets:
 * 15 m + 3 %, so a house in front hides them.
 */
export function toleranceM(kind: string, d: number): number {
	return (TERRAIN_KINDS.has(kind) || PLACE_KINDS.has(kind) ? 300 : 15) + 0.03 * d;
}

/** the bench's height band (SUMMIT_HEIGHT_ABS_M): how far above and below a peak or a place its
 * ground may show, metres */
export const BAND_M = 100;
const banded = (kind: string) => TERRAIN_KINDS.has(kind) || PLACE_KINDS.has(kind);

/**
 * Is a name seen? `own` is the scene's depth at its pixel, `band` the depths of every pixel row
 * across its height band (-1 = nothing drawn: sky). Seen when nothing is drawn well in front of
 * its own pixel, or when any band row shows ground at its own distance -- not merely something
 * behind it, which is any far hill. The probe's fragment shader is this, on the GPU
 * (DepthProbe); change one, change the other.
 */
export function verdict(D: number, tol: number, own: number, band: ArrayLike<number>): boolean {
	if (own < 0 || own >= D - tol) return true;
	for (let i = 0; i < band.length; i++) if (band[i] >= 0 && Math.abs(band[i] - D) <= tol) return true;
	return false;
}

export type Projected = {
	n: Named;
	/** canvas pixels (CSS), y down */
	cx: number;
	cy: number;
	/** texture coordinates of its pixel (y up), and its height band's extent in v */
	u: number;
	v: number;
	vLo: number;
	vHi: number;
	/** view depth, metres (along the camera axis, as the depth buffer measures it) */
	depth: number;
	/** horizontal distance from the camera, metres */
	d: number;
	/** a hidden place's hint: canvas y of the top edge of what hides it (`ridgeCy`) */
	ridgeCy?: number | null;
};

/**
 * The probe's word on a name: seen or not, the scene's depth at its own pixel, and -- hidden --
 * how far above it the scene stops hiding it (the occluder's ridge), as a difference of
 * tan(elevation) from the name: unchanged by a zoom, so a frame drawn between two verdicts still
 * puts the hint on the ridge (`ridgeCyOf`). null: the occluder reaches the top of the picture.
 */
export type Judged = { seen: boolean; own: number; lift: number | null };

/** canvas y of a hidden name's ridge, from its current texture v and the projection's p[5] */
export function ridgeCyOf(v: number, lift: number | null, p5: number, H: number): number | null {
	return lift === null ? null : (1 - (v + (lift * p5) / 2)) * H;
}

/** the probe's ridge (texture v, -1 if none) as a `lift`, given the name's v and p[5] when probed */
export function liftOf(ridgeV: number, v: number, p5: number): number | null {
	return ridgeV < 0 ? null : (2 * (ridgeV - v)) / p5;
}

/**
 * Names in front of the camera, inside the view and within their kind's distance, projected.
 * `view` and `proj` are three's column-major matrixWorldInverse and projectionMatrix.
 */
export function project(list: Named[], view: ArrayLike<number>, proj: ArrayLike<number>, cam: Vec3,
	W: number, H: number, relief: Relief | null, zoom = 1): Projected[] {
	const out: Projected[] = [];
	const e = view, p = proj;
	/** a scene point to texture u, v and view depth, or null when behind the camera */
	const toScreen = (x: number, y: number, z: number): { u: number; v: number; depth: number } | null => {
		const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
		const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
		const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
		if (vz >= -1) return null; // behind, or at the eye
		const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
		const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
		const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
		return { u: (cx / cw + 1) / 2, v: (cy / cw + 1) / 2, depth: -vz };
	};
	const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
	for (const n of list) {
		const d = Math.hypot(n.s[0] - cam[0], n.s[1] - cam[1]);
		if (d > maxDistance(n.kind, zoom)) continue;
		const [x, y, z] = relieved(n.s, cam, relief);
		const own = toScreen(x, y, z);
		if (!own || !(own.u >= 0 && own.u <= 1 && own.v >= 0 && own.v <= 1)) continue;
		let vLo = own.v, vHi = own.v;
		if (banded(n.kind)) {
			// "up" is the scene's z: the local vertical tilts under 1 degree in 100 km
			const hi = toScreen(x, y, z + BAND_M), lo = toScreen(x, y, z - BAND_M);
			if (hi) vHi = clamp01(Math.max(hi.v, own.v));
			if (lo) vLo = clamp01(Math.min(lo.v, own.v));
		}
		out.push({ n, cx: own.u * W, cy: (1 - own.v) * H, u: own.u, v: own.v, vLo, vHi, depth: own.depth, d });
	}
	return out;
}

export type Cls = 'seen' | 'direction';
export type Placed = SkyLabel & { kind: string; cls: Cls; id: string; alpha: number };

export const PILL_H = 18;
/** as the bench's labelPills: how far above the ridge a direction hint's leader stops, px */
const DIRECTION_LEADER_LIFT_PX = 8;
const SAME_NAME_PX = 250;
export const FONT = '500 12px system-ui, sans-serif';

/**
 * The names to draw, in the bench's order, laid out first-come. `vis` is the probe's verdict per
 * id (absent: not yet probed -- not drawn, so a name never flashes through a mountain). A hidden
 * notable place is a direction hint drawn at its `ridgeCy`, the top of what hides it; without
 * one (not yet probed, or the occluder fills the picture above it) it is not drawn.
 */
export function arrange(items: Projected[], vis: Map<string, Judged>, measure: (t: string) => number,
	W: number, H: number): Placed[] {
	const shown: (Projected & { cls: Cls })[] = [];
	for (const it of items) {
		if (it.n.alpha !== undefined && it.n.alpha <= 0) continue;
		const v = vis.get(it.n.id);
		if (!v) continue;
		if (v.seen) shown.push({ ...it, cls: 'seen' });
		else if (PLACE_KINDS.has(it.n.kind) && it.n.priority >= DIRECTION_MIN_PRIORITY &&
			it.d <= DIRECTION_MAX_DIST_M && v.own >= DIRECTION_MIN_OCCLUDER_M &&
			it.ridgeCy != null && it.ridgeCy >= 0 && it.ridgeCy < it.cy)
			shown.push({ ...it, cy: it.ridgeCy, cls: 'direction' });
	}
	shown.sort((a, b) => (a.cls === 'direction' ? 1 : 0) - (b.cls === 'direction' ? 1 : 0) ||
		b.n.priority - a.n.priority || a.depth - b.depth);
	// a street crossing three map tiles has three anchors: keep the nearest of a name's anchors
	// within SAME_NAME_PX of each other (a long avenue named again further on is fine)
	const kept: typeof shown = [];
	for (const s of shown) {
		if (!banded(s.n.kind) && kept.some((k) => k.n.text === s.n.text && !banded(k.n.kind) &&
			Math.hypot(k.cx - s.cx, k.cy - s.cy) < SAME_NAME_PX)) continue;
		kept.push(s);
	}
	return layoutSkyLabels(
		kept.map((s) => ({ label: s.n.text, cx: s.cx, cy: s.cy, pillW: measure(s.n.text) + 12, id: s.n.id,
			kind: s.n.kind, cls: s.cls, alpha: s.n.alpha ?? 1 })),
		W, H, { pillH: PILL_H }
	);
}

/** colours by what is named: terrain amber as on the bench, places blue, the map's own hues */
function swatch(kind: string): { pill: string; text: string; dot: string } {
	if (PLACE_KINDS.has(kind)) return { pill: 'rgba(30,58,95,0.88)', text: '#e6f0ff', dot: 'rgba(143,180,217,0.95)' };
	if (TERRAIN_KINDS.has(kind)) return { pill: 'rgba(250,215,60,0.92)', text: '#1a1400', dot: 'rgba(255,220,50,0.95)' };
	if (kind === 'water') return { pill: 'rgba(20,60,90,0.85)', text: '#9fd8ff', dot: 'rgba(80,170,230,0.95)' };
	if (kind === 'building') return { pill: 'rgba(60,40,15,0.85)', text: '#ffd8a8', dot: 'rgba(255,170,90,0.95)' };
	return { pill: 'rgba(15,40,30,0.85)', text: '#cff5e4', dot: 'rgba(70,214,160,0.95)' }; // streets
}

/** draw laid-out pills: every leader and dot first, then every pill, so no leader crosses a pill */
export function paint(ctx: CanvasRenderingContext2D, placed: Placed[]): void {
	ctx.font = FONT;
	ctx.textBaseline = 'middle';
	for (const l of placed) {
		const dim = l.cls === 'direction';
		ctx.globalAlpha = (dim ? 0.55 : 1) * l.alpha;
		ctx.strokeStyle = 'rgba(255,255,255,0.8)';
		ctx.lineWidth = 1;
		if (dim) ctx.setLineDash([3, 3]);
		ctx.beginPath();
		// a hint's leader stops clear of the ridge it stands on: the ridge is what hides the place
		ctx.moveTo(l.cx, l.cy - (dim ? DIRECTION_LEADER_LIFT_PX : 3));
		ctx.lineTo(l.ox, l.oy);
		ctx.stroke();
		ctx.setLineDash([]);
		if (!dim) {
			ctx.beginPath();
			ctx.arc(l.cx, l.cy, 2.2, 0, Math.PI * 2);
			ctx.fillStyle = swatch(l.kind).dot;
			ctx.fill();
		}
	}
	for (const l of placed) {
		const c = swatch(l.kind);
		ctx.globalAlpha = (l.cls === 'direction' ? 0.55 : 1) * l.alpha;
		ctx.save();
		ctx.translate(l.ox, l.oy);
		ctx.rotate(-l.angle);
		ctx.beginPath();
		ctx.roundRect(0, -l.pillH, l.pillW, l.pillH, 4);
		ctx.fillStyle = c.pill;
		ctx.fill();
		ctx.strokeStyle = 'rgba(0,0,0,0.35)';
		ctx.stroke();
		ctx.fillStyle = c.text;
		ctx.fillText(l.label, 6, -l.pillH / 2 + 0.5);
		ctx.restore();
	}
	ctx.globalAlpha = 1;
}

// --- the depth probe ---------------------------------------------------------------------------

/**
 * The verdict for a list of names, read off the frame's depth texture without stalling: one point
 * per name into a small float target, whose fragment shader takes the name's own pixel and then
 * walks every texel row of its height band (`verdict`, on the GPU), and readRenderTargetPixelsAsync.
 * Writes (seen 0/1, the depth at its own pixel, the ridge's v). The eye-depth formula is the EDL pass's
 * (the viewer's eye-dome pass), reversed or standard.
 */
export class DepthProbe {
	static readonly W = 64;
	static readonly MAX = 64 * 64;
	/** rows walked per band at most; a taller band is walked in even steps */
	static readonly STEPS = 160;
	busy = false;
	/** false once the browser cannot render to or read a float target: names are then unhidden */
	ok = true;
	private rt: THREE_NS.WebGLRenderTarget;
	private scene: THREE_NS.Scene;
	private cam: THREE_NS.OrthographicCamera;
	private geo: THREE_NS.BufferGeometry;
	private mat: THREE_NS.ShaderMaterial;
	private buf = new Float32Array(DepthProbe.MAX * 4);

	constructor(THREE: Three) {
		const W = DepthProbe.W;
		this.rt = new THREE.WebGLRenderTarget(W, W, {
			type: THREE.FloatType, format: THREE.RGBAFormat,
			minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false
		});
		this.geo = new THREE.BufferGeometry();
		const pos = new Float32Array(DepthProbe.MAX * 3);
		for (let i = 0; i < DepthProbe.MAX; i++) {
			pos[i * 3] = (((i % W) + 0.5) / W) * 2 - 1;
			pos[i * 3 + 1] = ((Math.floor(i / W) + 0.5) / W) * 2 - 1;
		}
		this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		// (u, v, vLo, vHi) and (D, tolerance) per name
		this.geo.setAttribute('aPix', new THREE.BufferAttribute(new Float32Array(DepthProbe.MAX * 4), 4));
		this.geo.setAttribute('aWin', new THREE.BufferAttribute(new Float32Array(DepthProbe.MAX * 2), 2));
		this.mat = new THREE.ShaderMaterial({
			uniforms: { tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 1000 }, uReversed: { value: 0 },
				uTexelY: { value: 0.001 } },
			vertexShader: `
				attribute vec4 aPix;
				attribute vec2 aWin;
				varying vec4 vPix;
				varying vec2 vWin;
				void main() { vPix = aPix; vWin = aWin; gl_PointSize = 1.0; gl_Position = vec4(position.xy, 0.0, 1.0); }
			`,
			fragmentShader: `
				precision highp float;
				varying vec4 vPix;
				varying vec2 vWin;
				uniform sampler2D tDepth;
				uniform float uNear, uFar, uReversed, uTexelY;
				float eyeZ(vec2 uv) {
					float d = texture2D(tDepth, uv).x;
					if (uReversed > 0.5) return d <= 0.0 ? -1.0 : (uNear * uFar) / (d * (uFar - uNear) + uNear);
					if (d >= 1.0) return -1.0;
					float ndc = d * 2.0 - 1.0;
					return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
				}
				void main() {
					float D = vWin.x, tol = vWin.y;
					float own = eyeZ(vPix.xy);
					float seen = (own < 0.0 || own >= D - tol) ? 1.0 : 0.0;
					float step = max(uTexelY, (vPix.w - vPix.z) / ${DepthProbe.STEPS.toFixed(1)});
					for (int i = 0; i <= ${DepthProbe.STEPS}; i++) {
						float v = vPix.z + float(i) * step;
						if (seen > 0.5 || v > vPix.w) break;
						float z = eyeZ(vec2(vPix.x, v));
						if (z >= 0.0 && abs(z - D) <= tol) seen = 1.0;
					}
					// hidden: the occluder's top edge above the name (a direction hint stands on it).
					// Coarse steps up to the top of the picture, then halving between the last row
					// still hidden and the first clear one.
					float ridge = -1.0;
					if (seen < 0.5) {
						float up = max(uTexelY, (1.0 - vPix.y) / ${DepthProbe.STEPS.toFixed(1)});
						float lo = vPix.y;
						for (int i = 1; i <= ${DepthProbe.STEPS}; i++) {
							float v = vPix.y + float(i) * up;
							if (v > 1.0) break;
							float z = eyeZ(vec2(vPix.x, v));
							if (z < 0.0 || z >= D - tol) { ridge = v; break; }
							lo = v;
						}
						if (ridge >= 0.0) {
							for (int k = 0; k < 12; k++) {
								if (ridge - lo <= uTexelY) break;
								float m = 0.5 * (lo + ridge);
								float z = eyeZ(vec2(vPix.x, m));
								if (z < 0.0 || z >= D - tol) ridge = m; else lo = m;
							}
						}
					}
					gl_FragColor = vec4(seen, own, ridge, 1.0);
				}
			`,
			depthTest: false,
			depthWrite: false
		});
		const pts = new THREE.Points(this.geo, this.mat);
		pts.frustumCulled = false;
		this.scene = new THREE.Scene();
		this.scene.add(pts);
		this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	}

	/**
	 * Judge `items` against `depth` (a texture `texH` texels tall). Must be called right after the
	 * frame was drawn into the depth texture's target: the read is queued before this returns.
	 * Resolves to (seen, own depth, ridge v or -1) per item, or null when the probe cannot run here.
	 */
	run(renderer: THREE_NS.WebGLRenderer, depth: THREE_NS.Texture, texH: number, items: Projected[],
		near: number, far: number, reversed: boolean): Promise<Float32Array | null> | null {
		if (this.busy || !this.ok) return null;
		const n = Math.min(DepthProbe.MAX, items.length);
		if (!n) return Promise.resolve(new Float32Array(0));
		const pix = this.geo.getAttribute('aPix') as THREE_NS.BufferAttribute;
		const win = this.geo.getAttribute('aWin') as THREE_NS.BufferAttribute;
		const P = pix.array as Float32Array, Wn = win.array as Float32Array;
		for (let i = 0; i < n; i++) {
			const it = items[i];
			P[i * 4] = it.u; P[i * 4 + 1] = it.v; P[i * 4 + 2] = it.vLo; P[i * 4 + 3] = it.vHi;
			Wn[i * 2] = it.depth; Wn[i * 2 + 1] = toleranceM(it.n.kind, it.depth);
		}
		pix.needsUpdate = true;
		win.needsUpdate = true;
		this.geo.setDrawRange(0, n);
		const u = this.mat.uniforms;
		u.tDepth.value = depth;
		u.uNear.value = near;
		u.uFar.value = far;
		u.uReversed.value = reversed ? 1 : 0;
		u.uTexelY.value = 1 / Math.max(1, texH);
		const W = DepthProbe.W, rows = Math.ceil(n / W);
		const prev = renderer.getRenderTarget();
		this.busy = true;
		try {
			renderer.setRenderTarget(this.rt);
			renderer.render(this.scene, this.cam);
			const read = renderer.readRenderTargetPixelsAsync(this.rt, 0, 0, W, rows, this.buf.subarray(0, W * rows * 4));
			renderer.setRenderTarget(prev);
			return read.then(() => {
				const out = new Float32Array(n * 3);
				for (let i = 0; i < n; i++)
					for (let c = 0; c < 3; c++) out[i * 3 + c] = this.buf[i * 4 + c];
				return out;
			}).catch(() => {
				this.ok = false;
				return null;
			}).finally(() => {
				this.busy = false;
			});
		} catch {
			renderer.setRenderTarget(prev);
			this.ok = false;
			this.busy = false;
			return Promise.resolve(null);
		}
	}

	dispose() {
		this.rt.dispose();
		this.geo.dispose();
		this.mat.dispose();
	}
}
