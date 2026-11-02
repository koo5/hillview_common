/**
 * The ground as a surface, loaded where the camera looks (2026-10-01).
 *
 * Tiles come from /terrain/tile/{z}/{x}/{y}.bin (api routers/terrain.py): a 65x65 grid of
 * ELLIPSOIDAL heights laid evenly in a slippy tile's Mercator square, so every sample is placed by
 * pure geometry -- lat, lon, h through ECEF into the world frame (geodesy.ts) -- and the earth's
 * curvature comes out right at any distance, which the telephoto overlay needs.
 *
 * Each tile is one mesh in ITS OWN local coordinates: vertices are stored relative to the tile's
 * centre, small numbers that float32 holds to a millimetre, and the centre goes into the mesh's
 * position, which three keeps in doubles and folds into the camera transform on the CPU. That is
 * what keeps a tile 100 km off from jittering, and a tile under the camera from shimmering.
 *
 * Which tiles: a quadtree from MIN_Z, a tile split while the camera is nearer than SPLIT times its
 * size, down to MAX_Z, capped at MAX_TILES. A tile still loading is stood in for by its nearest
 * loaded ancestor, so the ground thins rather than opening holes; skirts hang from every edge so
 * two zooms meeting do not show the sky through the seam.
 *
 * Shading is baked into vertex colours (a hillshade from the grid's own normals, sun from the
 * north-west): the scene has no lights, and the points must keep their photo colours.
 *
 * THE ORTHOPHOTO (2026-10-15), where `orthoUrl` is given: ČÚZK's, through earth, at the same slippy
 * address as the terrain tile, so it lies on the grid with uv = (column, 1 - row) and no
 * reprojection. Same zoom is enough: selection keeps a cell near pixelError pixels on screen, and a
 * 256 px tile over 64 cells is four texels a cell. Only at maxZ, where the tiles stop splitting
 * though the camera comes closer, is it a mosaic of finer ortho tiles. Under the photo is a plain
 * hillshade (the photo has its own shadows, so a soft one): the height ramp would tint it. Where
 * there is none (outside Czechia: earth answers 404) the ramp stays -- and where the photo has no
 * pixels (transparent: the overview before an area's sheets are fetched, a sheet's edge, the
 * border) the ramp shows through it (groundMaterial). It drew black there until 2026-11-02 (ea09).
 */
import type * as THREE_NS from 'three';
import { Frame, type Vec3 } from './geodesy';
import { WorldRequests, RequestFailure, responseOrThrow, requestHeaders } from './worldRequests';

type Three = typeof THREE_NS;

export type TerrainOptions = {
	/** a URL with {z}, {x}, {y} */
	tileUrl: string;
	/** the world frame the scene is drawn in */
	frame: Frame;
	minZ?: number;
	maxZ?: number;
	/** split a tile while one of its cells would cover more than this many pixels */
	pixelError?: number;
	maxTiles?: number;
	/** how far out tiles are asked for at all, metres */
	radiusM?: number;
	requests?: WorldRequests;
	/** the sea-coloured ellipsoid under the tiles (default on) */
	globe?: boolean;
	/** the orthophoto to drape, a URL with {z}, {x}, {y} at the terrain tiles' addresses; none if unset */
	orthoUrl?: string;
	/** the finest ortho zoom to ask for (the mosaic at maxZ) */
	orthoMaxZ?: number;
	onChange?: () => void;
};

export type TileKey = `${number}/${number}/${number}`;

type Tile = {
	key: TileKey;
	z: number;
	x: number;
	y: number;
	state: 'loading' | 'ready' | 'failed';
	complete?: boolean;
	requestState?: import('./worldRequests').RequestState;
	mesh?: THREE_NS.Mesh;
	/** the heights as served (ellipsoidal, NaN = none), for heightAt */
	h?: Float32Array;
	n?: number;
	/** the finest data under it, metres per sample (from the source bytes): where to stop splitting */
	res?: number;
	used: number;
	/** the orthophoto draped on it: none = there is none (404), so the height ramp stays */
	ortho?: 'loading' | 'ready' | 'none';
	tex?: THREE_NS.Texture;
};

const N_DEFAULT = 65;

/**
 * Metres per sample of each source byte (api routers/terrain.py TILE_SOURCES): ČÚZK 10 m, GLO-30,
 * ČÚZK 2 m bare and surface (zoom 16 and finer, where built), and bare earth's holes (under roofs,
 * on water) filled from the 10 m / 2 m ground round them: no finer than the mosaic they came from.
 */
export const SOURCE_RES: Record<number, number> = { 1: 10, 2: 10, 3: 30, 4: 2, 5: 2, 8: 10, 9: 2 };
/** the coarse global model (ETOPO, ~1.8 km): where finer data may well exist below -- not a stop */
const SRC_GLOBAL = 6;
/** the sea at 0 m: nothing finer to find, ever */
const SRC_SEA = 7;
/** what a tile is assumed to rest on before anything under it has loaded: the 10 m mosaics */
const RES_UNKNOWN = 10;

/**
 * A served tile's heights and sources, in either wire format (X-Tile-Format): `f32` -- float32
 * heights then a source byte each -- or `q16` -- b"HVQ1", a float64 base, int16 decimetre deltas
 * (each row's first sample against the row above's first, the others against their left
 * neighbour), then the source bytes (api encode_q16). A sample whose source is 0 has no ground.
 */
export function decodeTile(buf: ArrayBuffer, format: string | null, nHint = N_DEFAULT): { h: Float32Array; src: Uint8Array; n: number } {
	if (format === 'q16') {
		const n = Math.round(Math.sqrt((buf.byteLength - 12) / 3));
		const dv = new DataView(buf);
		const base = dv.getFloat64(4, true);
		const d = new Int16Array(buf.slice(12, 12 + 2 * n * n));
		const src = new Uint8Array(buf, 12 + 2 * n * n, n * n);
		const h = new Float32Array(n * n);
		let rowStart = 0;
		for (let r = 0; r < n; r++) {
			rowStart += d[r * n];
			let q = rowStart;
			for (let c = 0; c < n; c++) {
				if (c) q += d[r * n + c];
				h[r * n + c] = src[r * n + c] ? base + q / 10 : NaN;
			}
		}
		return { h, src, n };
	}
	const n = nHint;
	return { h: new Float32Array(buf, 0, n * n), src: new Uint8Array(buf, 4 * n * n, n * n), n };
}

/**
 * The finest resolution among a tile's samples, metres; null when unknown. Ground known only from
 * the coarse global model is unknown, not 1.8 km: ČÚZK or GLO-30 may be waiting below (GLO-30 is
 * fetched from zoom 10 only). A tile of nothing but sea has nothing finer to give.
 */
export function finestRes(src: Uint8Array): number | null {
	let best = Infinity, global = false, sea = false;
	for (const s of src) {
		if (s === SRC_GLOBAL) global = true;
		else if (s === SRC_SEA) sea = true;
		else if (s && SOURCE_RES[s] !== undefined && SOURCE_RES[s] < best) best = SOURCE_RES[s];
	}
	if (Number.isFinite(best)) return best;
	if (global) return null;
	return sea ? 1e9 : null;
}

/** how high ground may rise at the horizon, for how far a camera can see: the Alps and then some */
const HORIZON_GROUND_M = 5_000;
const R_EARTH = 6_371_000;
/** how far a camera this high above the ellipsoid can see ground, metres (its horizon, plus how
 * far beyond it a HORIZON_GROUND_M summit still shows) */
export function horizonM(heightM: number): number {
	const h = Math.max(0, heightM);
	return Math.sqrt(h * (2 * R_EARTH + h)) + Math.sqrt(2 * R_EARTH * HORIZON_GROUND_M);
}

/** a tile's size on the ground, metres, from its angles -- corners projected into one tangent
 * frame mean nothing for a tile that spans a hemisphere */
function tileSizeM(b: { w: number; e: number; n: number; s: number }): number {
	const r = Math.PI / 180;
	const w = (b.e - b.w) * r * R_EARTH * Math.cos(((b.n + b.s) / 2) * r);
	const h = (b.n - b.s) * r * R_EARTH;
	return (w + h) / 2;
}

export function tileOf(lat: number, lon: number, z: number): [number, number] {
	const k = 2 ** z;
	const x = Math.floor(((lon + 180) / 360) * k);
	const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * k);
	return [Math.min(k - 1, Math.max(0, x)), Math.min(k - 1, Math.max(0, y))];
}

export function tileLonLat(z: number, x: number, y: number): { w: number; e: number; n: number; s: number } {
	const k = 2 ** z;
	const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / k))) * 180) / Math.PI;
	return { w: (x / k) * 360 - 180, e: ((x + 1) / k) * 360 - 180, n: lat(y), s: lat(y + 1) };
}

/** The grid the API samples a tile on: row-major from the north-west corner, even in Mercator. */
export function tileGrid(z: number, x: number, y: number, n = N_DEFAULT): { lons: Float64Array; lats: Float64Array } {
	const k = 2 ** z;
	const lons = new Float64Array(n * n), lats = new Float64Array(n * n);
	for (let r = 0; r < n; r++) {
		const t = r / (n - 1);
		const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + t)) / k))) * 180) / Math.PI;
		for (let c = 0; c < n; c++) {
			lons[r * n + c] = ((x + c / (n - 1)) / k) * 360 - 180;
			lats[r * n + c] = lat;
		}
	}
	return { lons, lats };
}

/**
 * A tile's height at a point, bilinear on its grid (Mercator-even, as tileGrid lays it); null
 * outside the tile or where a corner has no value. What the mesh draws between samples is two
 * triangles, not a bilinear patch -- the difference is a fraction of the relief within one cell.
 */
export function sampleTile(h: Float32Array, n: number, z: number, x: number, y: number,
	lat: number, lon: number): number | null {
	const k = 2 ** z;
	const fx = (((lon + 180) / 360) * k - x) * (n - 1);
	const fy = (((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * k - y) * (n - 1);
	if (!(fx >= 0 && fy >= 0 && fx <= n - 1 && fy <= n - 1)) return null;
	const c0 = Math.min(n - 2, Math.floor(fx)), r0 = Math.min(n - 2, Math.floor(fy));
	const tx = fx - c0, ty = fy - r0;
	const a = h[r0 * n + c0], b = h[r0 * n + c0 + 1], c = h[(r0 + 1) * n + c0], d = h[(r0 + 1) * n + c0 + 1];
	if (![a, b, c, d].every(Number.isFinite)) return null;
	return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * What the camera sees: its forward direction in the world frame, its vertical field of view in
 * degrees, and the canvas it is drawn on. Tile detail follows from it: what a cell COVERS ON SCREEN.
 */
export type View = { dir: Vec3; fovY: number; aspect: number; heightPx: number };

/** the view a tile is judged by when nothing better is known, or when it is out of view */
export const REF_VIEW: View = { dir: [0, 1, 0], fovY: 55, aspect: 1.6, heightPx: 1000 };

/** pixels per radian at the centre of a view */
export function pxPerRad(v: View): number {
	return v.heightPx / (2 * Math.tan((v.fovY * Math.PI) / 360));
}

/** how many times a view magnifies against the reference: 1 at 55 degrees, ~110 at 0.5 */
export function zoomOf(v: View): number {
	return Math.tan((REF_VIEW.fovY * Math.PI) / 360) / Math.tan((v.fovY * Math.PI) / 360);
}

/**
 * The tiles to draw for a camera, chosen by the error they make ON SCREEN (2026-10-02). Start from
 * MIN_Z tiles round it and keep splitting the leaf whose cells cover the most pixels, while that
 * is more than `pixelError` and the set is under `maxTiles`.
 *
 * A tile in view is measured at the view's own magnification, so zooming in on a ridge 30 km off
 * pours the budget into the narrow wedge it covers -- before this, detail followed distance alone,
 * and a 0.5-degree view of that ridge drew it from ~100 m cells. A tile out of view is measured at
 * half the reference view's: coarse, but there, so turning round shows ground at once while the
 * finer tiles load. Without a `view`, every tile is judged at the reference view -- about the old
 * rule (split within 2.2 tile widths) at 6 px.
 *
 * Priority, not breadth: a breadth-first split spent the cap on rings of mid-distance tiles and
 * never reached the ground under the camera. Returned nearest first, the order to load in.
 */
/**
 * The tile budget for a view: up to twice `maxTiles` as the view magnifies (x2 from about 16x,
 * a ~4-degree field of view). A telephoto view of a plain sees ground from a few km out to the
 * horizon along its bottom edge, all of it fine on screen; at the base budget a ridge 30 km off
 * got zoom 14 (~25 m cells) at 0.5 degrees, at twice it zoom 16. An ordinary view stops short of
 * either by the pixel error alone.
 */
export function budgetFor(maxTiles: number, view?: View): number {
	const z = view ? zoomOf(view) : 1;
	return Math.round(maxTiles * Math.min(2, 1 + Math.log2(Math.max(1, z)) / 4));
}

/** ellipsoidal heights a tile's ground may span, when nothing loaded says better: CZ and its
 * neighbours lie between the sea and ~1.6 km up, plus EGM2008 N (~45 m) */
const GROUND_RANGE: [number, number] = [-100, 2_000];

/**
 * Is a box of world-frame points inside the view's frustum (four side planes through the eye)?
 * Conservative: out only when every point is outside the same plane.
 */
export function inFrustum(pts: Vec3[], cam: Vec3, view: View): boolean {
	const f = normalize(view.dir);
	// right and up of the camera; the world's up is z (a camera looking straight down is
	// given an arbitrary but consistent roll -- a cone test would not care either)
	let r = normalize([f[1], -f[0], 0]);
	if (!Number.isFinite(r[0]) || Math.hypot(...r) < 0.5) r = [1, 0, 0];
	const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
	const ty = Math.tan((view.fovY * Math.PI) / 360), tx = ty * view.aspect;
	let allLeft = true, allRight = true, allDown = true, allUp = true, allBehind = true;
	for (const p of pts) {
		const q = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
		const z = q[0] * f[0] + q[1] * f[1] + q[2] * f[2];
		const x = q[0] * r[0] + q[1] * r[1] + q[2] * r[2];
		const y = q[0] * u[0] + q[1] * u[1] + q[2] * u[2];
		if (z > 0) allBehind = false;
		if (x >= -tx * z) allLeft = false;
		if (x <= tx * z) allRight = false;
		if (y >= -ty * z) allDown = false;
		if (y <= ty * z) allUp = false;
	}
	return !(allBehind || allLeft || allRight || allDown || allUp);
}

export function selectTiles(
	frame: Frame,
	cam: Vec3,
	o: { minZ: number; maxZ: number; pixelError: number; maxTiles: number; radiusM: number },
	view?: View,
	/** the ground's ellipsoidal height range over a tile, from what is loaded; null = unknown */
	heightRange?: (z: number, x: number, y: number) => [number, number] | null,
	/** the finest data known under a tile, metres per sample; null = unknown (taken as 10 m) */
	dataRes?: (z: number, x: number, y: number) => number | null
): [number, number, number][] {
	const [clat, clon, chgt] = frame.toGeodetic(...cam);
	// THE HORIZON, not a fixed disc (2026-10-02): from the ground ~310 km, from 100 km up ~1,400 km
	const reach = Math.min(o.radiusM, horizonM(chgt));
	const dLat = reach / 111_000;
	const dLon = reach / (111_000 * Math.max(0.1, Math.cos((clat * Math.PI) / 180)));
	const [x0, y0] = tileOf(clat + dLat, clon - dLon, o.minZ);
	const [x1, y1] = tileOf(clat - dLat, clon + dLon, o.minZ);
	const kIn = pxPerRad(view ?? REF_VIEW), kOut = view ? pxPerRad(REF_VIEW) / 2 : kIn;
	type Leaf = { z: number; x: number; y: number; size: number; d: number; px: number };
	const measure = (z: number, x: number, y: number): Leaf => {
		const b = tileLonLat(z, x, y);
		const c = frame.fromGeodetic((b.n + b.s) / 2, (b.w + b.e) / 2, frame.h);
		const size = tileSizeM(b);
		const to: Vec3 = [c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]];
		const dc = Math.hypot(...to);
		// distance to the tile, not to its centre: the camera may be standing in it
		const d = Math.max(0, dc - size / 2);
		let k = kIn;
		if (view && dc > size) {
			// the tile as a box: its corners at the lowest and highest ground it can have
			const [h0, h1] = heightRange?.(z, x, y) ?? GROUND_RANGE;
			const box: Vec3[] = [];
			// a big tile bulges with the earth between its corners: sample it on a grid
			const g = z < 6 ? 4 : 1;
			for (const h of [h0, h1]) for (let i = 0; i <= g; i++) for (let j = 0; j <= g; j++)
				box.push(frame.fromGeodetic(b.s + ((b.n - b.s) * i) / g, b.w + ((b.e - b.w) * j) / g, h));
			if (g === 1) for (const h of [h0, h1]) box.push(frame.fromGeodetic((b.n + b.s) / 2, (b.w + b.e) / 2, h));
			if (!inFrustum(box, cam, view)) k = kOut;
		}
		// one cell of the tile, as seen from the camera, in pixels
		return { z, x, y, size, d, px: ((size / (N_DEFAULT - 1)) / Math.max(d, 1)) * k };
	};
	let leaves: Leaf[] = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
		const l = measure(o.minZ, x, y);
		if (l.d <= reach + l.size) leaves.push(l);
	}
	// no finer than the data: a tile whose cells are already smaller than its samples gains
	// nothing by splitting (10 m mosaics stop at zoom 16, GLO-30 at 14, 2 m at 18)
	const want = (l: Leaf) => l.z < o.maxZ && l.px > o.pixelError &&
		l.size / (N_DEFAULT - 1) > (dataRes?.(l.z, l.x, l.y) ?? RES_UNKNOWN);
	while (leaves.length + 3 <= o.maxTiles) {
		let best = -1, score = 0;
		for (let i = 0; i < leaves.length; i++) {
			const l = leaves[i];
			if (!want(l)) continue;
			if (l.px > score) { score = l.px; best = i; }
		}
		if (best < 0) break;
		const { z, x, y } = leaves[best];
		leaves.splice(best, 1);
		// a child wholly beyond the horizon is not drawn at all
		for (const [cx, cy] of [[2 * x, 2 * y], [2 * x + 1, 2 * y], [2 * x, 2 * y + 1], [2 * x + 1, 2 * y + 1]]) {
			const l = measure(z + 1, cx, cy);
			if (l.d <= reach) leaves.push(l);
		}
	}
	leaves = leaves.sort((a, b) => a.d - b.d);
	return leaves.map((l) => [l.z, l.x, l.y]);
}

function normalize(a: Vec3): Vec3 {
	const n = Math.hypot(...a) || 1;
	return [a[0] / n, a[1] / n, a[2] / n];
}

/** how far in from its edge a hole is filled, on the ground: a river, a lake, a large roof */
const FILL_M = 300;

/**
 * NaN cells filled from their known 8-neighbours, one ring per pass; `mask` marks the filled ones.
 * A hole wider than 2 x passes cells stays a hole -- nothing is invented from nowhere.
 */
export function fillHoles(h: Float32Array, n: number, passes: number): { h: Float32Array; mask: Uint8Array } {
	const out = new Float32Array(h);
	const mask = new Uint8Array(n * n);
	for (let p = 0; p < passes; p++) {
		const next = new Float32Array(out);
		let changed = 0;
		for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
			const i = r * n + c;
			if (Number.isFinite(out[i])) continue;
			let sum = 0, k = 0;
			for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
				const rr = r + dr, cc = c + dc;
				if ((dr || dc) && rr >= 0 && rr < n && cc >= 0 && cc < n && Number.isFinite(out[rr * n + cc])) {
					sum += out[rr * n + cc];
					k++;
				}
			}
			if (k) { next[i] = sum / k; mask[i] = 1; changed++; }
		}
		out.set(next);
		if (!changed) break;
	}
	return { h: out, mask };
}

/** low ground to high: greens to earth, muted for the dark scene */
function ramp(t: number): Vec3 {
	const stops: [number, Vec3][] = [[0, [0.20, 0.27, 0.19]], [0.35, [0.30, 0.34, 0.22]], [0.7, [0.42, 0.37, 0.28]], [1, [0.62, 0.60, 0.58]]];
	t = Math.min(1, Math.max(0, t));
	for (let i = 1; i < stops.length; i++) {
		if (t <= stops[i][0]) {
			const [t0, a] = stops[i - 1], [t1, b] = stops[i];
			const f = (t - t0) / (t1 - t0);
			return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
		}
	}
	return stops[stops.length - 1][1];
}

/**
 * Build a tile's mesh from its heights. Vertices relative to the tile's centre; NaN samples make
 * no triangles; skirts drop each edge by `skirt` metres along the tile's own up.
 */
export function buildTileMesh(
	THREE: Three,
	frame: Frame,
	z: number,
	x: number,
	y: number,
	heights: Float32Array,
	n = N_DEFAULT,
	/** each sample's source byte, if known: the sea (SRC_SEA) is drawn sea-coloured, not as lowland */
	src?: Uint8Array
): THREE_NS.Mesh | null {
	const { lons, lats } = tileGrid(z, x, y, n);
	const b = tileLonLat(z, x, y);
	// HOLES FILLED, AND SAID TO BE. ČÚZK bare earth has no value over water and under some large
	// buildings, and the background showed through as black lakes and rivers. A hole is filled
	// from its known neighbours, ring by ring, up to FILL_M in from its edge -- in METRES, not cells:
	// counted in cells, a coarse tile with a few samples was flooded into a flat slab -- and the
	// filled ground is drawn desaturated: interpolated, not measured.
	const ne0 = frame.fromGeodetic(b.n, b.e, 0), sw0 = frame.fromGeodetic(b.s, b.w, 0);
	const cell = Math.hypot(ne0[0] - sw0[0], ne0[1] - sw0[1]) / Math.SQRT2 / (n - 1);
	const filled = fillHoles(heights, n, Math.min(48, Math.floor(FILL_M / cell)));
	heights = filled.h;
	let hSum = 0, hN = 0;
	for (const h of heights) if (Number.isFinite(h)) { hSum += h; hN++; }
	if (!hN) return null;
	const centre = frame.fromGeodetic((b.n + b.s) / 2, (b.w + b.e) / 2, hSum / hN);
	const up = new Frame((b.n + b.s) / 2, (b.w + b.e) / 2).upIn(frame);
	const ne = frame.fromGeodetic(b.n, b.e, 0), sw = frame.fromGeodetic(b.s, b.w, 0);
	const size = Math.hypot(ne[0] - sw[0], ne[1] - sw[1]) / Math.SQRT2;
	const skirt = 5 + size * 0.02;
	const nv = n * n;
	const pos = new Float32Array((nv + 4 * n) * 3);
	const col = new Float32Array((nv + 4 * n) * 3);
	// the orthophoto's place on the grid (row 0 is the north edge, the image's top), and the shade
	// alone for under it
	const uv = new Float32Array((nv + 4 * n) * 2);
	const shadeCol = new Float32Array((nv + 4 * n) * 3);
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
		uv[(r * n + c) * 2] = c / (n - 1); uv[(r * n + c) * 2 + 1] = 1 - r / (n - 1);
	}
	const ok = new Uint8Array(nv);
	const P: Vec3[] = new Array(nv);
	for (let i = 0; i < nv; i++) {
		const h = heights[i];
		if (!Number.isFinite(h)) continue;
		ok[i] = 1;
		const w = frame.fromGeodetic(lats[i], lons[i], h);
		P[i] = w;
		pos[i * 3] = w[0] - centre[0]; pos[i * 3 + 1] = w[1] - centre[1]; pos[i * 3 + 2] = w[2] - centre[2];
	}
	// hillshade from the grid's own neighbours, sun from the north-west, 40 degrees up
	const sunAz = (315 * Math.PI) / 180, sunEl = (40 * Math.PI) / 180;
	const sun: Vec3 = [Math.sin(sunAz) * Math.cos(sunEl), Math.cos(sunAz) * Math.cos(sunEl), Math.sin(sunEl)];
	// a neighbour's position, or this vertex's own where the neighbour is off the grid or NaN
	const at = (r: number, c: number, i: number): Vec3 => {
		if (r < 0 || r >= n || c < 0 || c >= n) return P[i];
		const j = r * n + c;
		return ok[j] ? P[j] : P[i];
	};
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
		const i = r * n + c;
		if (!ok[i]) continue;
		const L = at(r, c - 1, i), R = at(r, c + 1, i), U = at(r - 1, c, i), D = at(r + 1, c, i);
		// east along the row, north up the rows (row 0 is the north edge): east x north = up
		const ax = [R[0] - L[0], R[1] - L[1], R[2] - L[2]], ay = [U[0] - D[0], U[1] - D[1], U[2] - D[2]];
		let nx = ax[1] * ay[2] - ax[2] * ay[1], ny = ax[2] * ay[0] - ax[0] * ay[2], nz = ax[0] * ay[1] - ax[1] * ay[0];
		const len = Math.hypot(nx, ny, nz) || 1;
		nx /= len; ny /= len; nz /= len;
		const lit = Math.max(0, nx * sun[0] + ny * sun[1] + nz * sun[2]);
		const shade = 0.35 + 0.75 * lit;
		const soft = 0.8 + 0.3 * lit;
		shadeCol[i * 3] = soft; shadeCol[i * 3 + 1] = soft; shadeCol[i * 3 + 2] = soft;
		// heights above the frame's datum, ~orthometric near it: 150 m lowland .. 900 m hills
		let base = ramp((heights[i] - frame.h - 150) / 750);
		if (filled.mask[i]) {
			const grey = (base[0] + base[1] + base[2]) / 3;
			base = [grey * 0.85, grey * 0.9, grey * 1.05];
		}
		if (src && src[i] === SRC_SEA) {
			// flat water: no hillshade, the globe's own blue a shade lighter
			col[i * 3] = 0.14; col[i * 3 + 1] = 0.27; col[i * 3 + 2] = 0.4;
			continue;
		}
		col[i * 3] = base[0] * shade; col[i * 3 + 1] = base[1] * shade; col[i * 3 + 2] = base[2] * shade;
	}
	const idx: number[] = [];
	for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
		const a = r * n + c, bb = a + 1, cc = a + n, d = cc + 1;
		if (ok[a] && ok[cc] && ok[bb]) idx.push(a, cc, bb);
		if (ok[bb] && ok[cc] && ok[d]) idx.push(bb, cc, d);
	}
	// skirts: each edge vertex again, dropped along the tile's up, and a quad strip between
	const edges: number[][] = [[], [], [], []];
	for (let c = 0; c < n; c++) { edges[0].push(c); edges[2].push((n - 1) * n + (n - 1 - c)); }
	for (let r = 0; r < n; r++) { edges[1].push(r * n + n - 1); edges[3].push((n - 1 - r) * n); }
	let k = nv;
	for (const e of edges) {
		const first = k;
		for (const i of e) {
			pos[k * 3] = pos[i * 3] - up[0] * skirt; pos[k * 3 + 1] = pos[i * 3 + 1] - up[1] * skirt; pos[k * 3 + 2] = pos[i * 3 + 2] - up[2] * skirt;
			col[k * 3] = col[i * 3] * 0.8; col[k * 3 + 1] = col[i * 3 + 1] * 0.8; col[k * 3 + 2] = col[i * 3 + 2] * 0.8;
			uv[k * 2] = uv[i * 2]; uv[k * 2 + 1] = uv[i * 2 + 1];
			shadeCol[k * 3] = shadeCol[i * 3] * 0.8; shadeCol[k * 3 + 1] = shadeCol[i * 3 + 1] * 0.8; shadeCol[k * 3 + 2] = shadeCol[i * 3 + 2] * 0.8;
			k++;
		}
		for (let j = 0; j < e.length - 1; j++) {
			const a = e[j], bb = e[j + 1], a2 = first + j, b2 = first + j + 1;
			if (ok[a] && ok[bb]) idx.push(a, bb, a2, bb, b2, a2);
		}
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	g.setAttribute('color', new THREE.BufferAttribute(col, 3));
	g.setAttribute('shade', new THREE.BufferAttribute(shadeCol, 3));
	g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
	g.setIndex(idx);
	g.computeBoundingSphere();
	const m = new THREE.Mesh(g, groundMaterial(THREE));
	m.position.set(centre[0], centre[1], centre[2]);
	m.userData.tile = `${z}/${x}/${y}`;
	return m;
}

/**
 * The ground's material: the height ramp ('color'), and once a photo is draped, the photo under the soft
 * hillshade ('shade') wherever it has pixels, blended by its alpha. The photo is premultiplied
 * (drapeOrtho's texture), so the ramp * (1 - a) + photo is right at its edges too, filtering adds no fringe.
 * An opaque photo draws exactly as before: photo * shade.
 */
export function groundMaterial(THREE: Three): THREE_NS.MeshBasicMaterial {
	const m = new THREE.MeshBasicMaterial({
		vertexColors: true, side: THREE.DoubleSide,
		// the ground sits a hair behind what stands on it: points, footprints, the grid
		polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
	});
	m.onBeforeCompile = (sh) => {
		sh.vertexShader = sh.vertexShader
			.replace('#include <color_pars_vertex>', '#include <color_pars_vertex>\nattribute vec3 shade;\nvarying vec3 vShade;')
			.replace('#include <color_vertex>', '#include <color_vertex>\n\tvShade = shade;');
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <color_pars_fragment>', '#include <color_pars_fragment>\nvarying vec3 vShade;')
			.replace('#include <map_fragment>', '')
			.replace('#include <color_fragment>', GROUND_COLOR);
	};
	m.customProgramCacheKey = () => 'world-ground';
	return m;
}

// vColor is a vec4 since three r16x (color_pars_fragment), the ramp in its rgb
const GROUND_COLOR = `#ifdef USE_MAP
	vec4 photo = texture2D( map, vMapUv );
	diffuseColor.rgb = diffuseColor.rgb * vColor.rgb * ( 1.0 - photo.a ) + photo.rgb * vShade;
#else
	diffuseColor *= vColor;
#endif`;

/** Lay a loaded orthophoto on a tile's mesh: the photo, under the plain hillshade, the ramp where it has none. */
export function drapeOrtho(mesh: THREE_NS.Mesh, tex: THREE_NS.Texture) {
	const mat = mesh.material as THREE_NS.MeshBasicMaterial;
	mat.map = tex;
	mat.needsUpdate = true;
}

/**
 * The ortho tiles that cover terrain tile z/x/y at ortho zoom z + dz, drawn into one canvas
 * (256 << dz px, north up): a tile with none is left blank; null when none of them has any.
 */
export async function loadOrtho(url: string, z: number, x: number, y: number, dz: number,
	signal: AbortSignal, requestId: string): Promise<HTMLCanvasElement | null> {
	const k = 1 << dz, size = 256 * k;
	const canvas = document.createElement('canvas');
	canvas.width = size; canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	let drawn = 0;
	await Promise.all(Array.from({ length: k * k }, async (_, i) => {
		const cx = i % k, cy = Math.floor(i / k);
		const u = url.replace('{z}', String(z + dz)).replace('{x}', String(x * k + cx)).replace('{y}', String(y * k + cy));
		const r = await fetch(u, { signal, headers: requestHeaders(u, undefined, requestId) });
		if (r.status === 404) return;
		if (!r.ok) throw new RequestFailure(`Orthophoto HTTP ${r.status}`, r.status === 429 || r.status >= 500);
		const img = await createImageBitmap(await r.blob());
		ctx.drawImage(img, cx * 256, cy * 256, 256, 256);
		img.close();
		drawn++;
	}));
	return drawn ? canvas : null;
}

/**
 * The earth under the tiles (2026-10-02): a plain ellipsoid, sea-coloured, ice above 85 degrees
 * (where slippy tiles stop), 1 km below the ellipsoid and pushed further back in depth than the
 * tiles -- for the poles and for whatever has not loaded. At 150 m, with the tiles' own depth
 * offset (the ground sits a hair behind what stands on it), grazing views from orbit drew it over
 * every lowland. Its chords sag inward between vertices, so it only ever lies lower still.
 */
export function buildGlobe(THREE: Three, frame: Frame, stepDeg = 1.5): THREE_NS.Mesh {
	const nLat = Math.round(180 / stepDeg), nLon = Math.round(360 / stepDeg);
	const pos = new Float32Array((nLat + 1) * (nLon + 1) * 3);
	const col = new Float32Array((nLat + 1) * (nLon + 1) * 3);
	const sea = [0.12, 0.23, 0.34], ice = [0.86, 0.9, 0.93];
	let k = 0;
	for (let i = 0; i <= nLat; i++) {
		const lat = -90 + i * stepDeg;
		const c = Math.abs(lat) > 85 ? ice : sea;
		for (let j = 0; j <= nLon; j++) {
			const p = frame.fromGeodetic(lat, -180 + j * stepDeg, -1000);
			pos.set(p, k * 3);
			col.set(c, k * 3);
			k++;
		}
	}
	const idx: number[] = [];
	for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
		const a = i * (nLon + 1) + j, b = a + 1, c = a + nLon + 1, d = c + 1;
		idx.push(a, b, d, a, d, c);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	g.setAttribute('color', new THREE.BufferAttribute(col, 3));
	g.setIndex(idx);
	g.computeBoundingSphere();
	const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide,
		polygonOffset: true, polygonOffsetFactor: 8, polygonOffsetUnits: 8 }));
	m.name = 'globe';
	m.userData.globe = true;
	return m;
}

export class TerrainTiles {
	readonly group: THREE_NS.Group;
	private tiles = new Map<TileKey, Tile>();
	private wanted: TileKey[] = [];
	private requests: WorldRequests;
	private requestScope: string;
	private ownsRequests: boolean;
	private tick = 0;
	private disposed = false;
	/** bumped whenever a tile becomes ready: what heightAt answers may have changed */
	version = 0;
	/** the earth under the tiles (buildGlobe) */
	readonly globe?: THREE_NS.Mesh;
	readonly o: Required<Omit<TerrainOptions, 'onChange' | 'requests' | 'globe' | 'orthoUrl'>> & Pick<TerrainOptions, 'onChange' | 'requests' | 'globe' | 'orthoUrl'>;
	private orthoScope: string;

	constructor(private THREE: Three, opts: TerrainOptions) {
		// 220, doubled when zoomed in (budgetFor). Raising it to 400 was tried (2026-10-02) on a
		// reading that turned out to be a stale names verdict; measured honestly it did not help
		// (Melnik 81 % at 220, 76 % at 400).
		this.o = { minZ: 0, maxZ: 18, pixelError: 3, maxTiles: 220, radiusM: Infinity, orthoMaxZ: 20, ...opts };
		this.group = new THREE.Group();
		this.group.name = 'terrain';
		if (opts.globe !== false) {
			this.globe = buildGlobe(THREE, opts.frame);
			this.group.add(this.globe);
		}
		this.requests = opts.requests ?? new WorldRequests();
		this.ownsRequests = !opts.requests;
		this.requestScope = this.requests.scope('terrain');
		this.orthoScope = this.requests.scope('ortho');
	}

	get stats() {
		let ready = 0, loading = 0, failed = 0, ortho = 0, noOrtho = 0;
		for (const k of this.wanted) {
			const t = this.tiles.get(k);
			if (t?.state === 'ready' && t.complete !== false) ready++;
			else if (t?.state === 'failed' || t?.requestState === 'failed') failed++;
			else loading++;
			if (t?.ortho === 'ready') ortho++;
			else if (t?.ortho === 'none') noOrtho++;
		}
		return { wanted: this.wanted.length, ready, loading, failed, cached: this.tiles.size, ortho, noOrtho };
	}

	/** settled: every wanted tile is loaded or has failed */
	get settled() {
		return this.stats.loading === 0;
	}

	/**
	 * The ground's height range over a tile, from its finest loaded ANCESTOR's samples over its area
	 * (a cell of margin round them); null when none is loaded.
	 *
	 * Never from the tile itself (2026-10-02): its range decides whether it is in view, and so
	 * whether it is wanted at all. Read from itself, a tile's own arrival could move it out of view
	 * and its children out of the selection, and with eviction in the loop the near ground never
	 * settled ("the nearby terrain never seems to settle"). From ancestors only, what a tile is
	 * judged by is fixed before it loads, and the selection only moves forward as data arrives.
	 */
	heightRange(z: number, x: number, y: number): [number, number] | null {
		for (let zz = z - 1; zz >= this.o.minZ; zz--) {
			const s = z - zz, ax = x >> s, ay = y >> s;
			const t = this.tiles.get(`${zz}/${ax}/${ay}` as TileKey);
			if (t?.state !== 'ready' || !t.h || !t.n) continue;
			const n = t.n, k = 2 ** s;
			const c0 = Math.max(0, Math.floor(((x - ax * k) / k) * (n - 1)) - 1);
			const c1 = Math.min(n - 1, Math.ceil(((x + 1 - ax * k) / k) * (n - 1)) + 1);
			const r0 = Math.max(0, Math.floor(((y - ay * k) / k) * (n - 1)) - 1);
			const r1 = Math.min(n - 1, Math.ceil(((y + 1 - ay * k) / k) * (n - 1)) + 1);
			let lo = Infinity, hi = -Infinity;
			for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
				const v = t.h[r * n + c];
				if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
			}
			// an ancestor's coarse samples miss peaks and pits inside the tile: a margin
			if (lo <= hi) return [lo - 30 - 10 * s, hi + 30 + 10 * s];
		}
		return null;
	}

	/** the finest data under a tile, from itself or its nearest loaded ancestor; null = unknown */
	dataRes(z: number, x: number, y: number): number | null {
		for (let zz = z; zz >= this.o.minZ; zz--) {
			const t = this.tiles.get(`${zz}/${x >> (z - zz)}/${y >> (z - zz)}` as TileKey);
			if (t?.state === 'ready' && t.res !== undefined) return t.res;
		}
		return null;
	}

	update(cam: Vec3, view?: View) {
		if (this.disposed) return;
		this.tick++;
		const sel = selectTiles(this.o.frame, cam, { ...this.o, maxTiles: budgetFor(this.o.maxTiles, view) }, view,
			(z, x, y) => this.heightRange(z, x, y), (z, x, y) => this.dataRes(z, x, y));
		this.wanted = sel.map(([z, x, y]) => `${z}/${x}/${y}` as TileKey);
		// selectTiles returns them nearest first, which is the order they should load in
		for (const k of this.wanted) {
			const t = this.tiles.get(k);
			if (t) t.used = this.tick;
		}
		this.pump();
		this.compose();
		this.evict();
	}

	private pump() {
		this.requests.reconcile(this.requestScope, this.wanted.map((key, priority) => {
			const [z, x, y] = key.split('/').map(Number);
			const t: Tile = this.tiles.get(key) ?? { key, z, x, y, state: 'loading', used: this.tick };
			this.tiles.set(key, t);
			const url = this.o.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
			return {
				id: key, label: `Terrain ${key}`, kind: 'terrain' as const, url, priority, cacheable: true,
				run: async (signal: AbortSignal, requestId: string) => {
					const r = await responseOrThrow(url, signal, { headers: requestHeaders(url, undefined, requestId) });
					const buf = await r.arrayBuffer();
					signal.throwIfAborted();
					if (this.disposed) return;
					const { h, src, n } = decodeTile(buf, r.headers.get('X-Tile-Format'),
						parseInt(r.headers.get('X-Tile-N') ?? '65', 10) || 65);
					t.res = finestRes(src) ?? undefined;
					t.mesh?.geometry.dispose();
					(t.mesh?.material as THREE_NS.Material | undefined)?.dispose();
					t.mesh = buildTileMesh(this.THREE, this.o.frame, z, x, y, h, n, src) ?? undefined;
					if (t.mesh && t.tex) drapeOrtho(t.mesh, t.tex);
					t.h = h; t.n = n; t.state = 'ready'; this.version++;
					t.complete = r.headers.get('X-Tile-Complete') !== '0';
					this.compose(); this.o.onChange?.();
					if (!t.complete) throw new RequestFailure(`Terrain incomplete (${r.headers.get('X-Tile-Status') ?? 'missing heights'}); ${r.headers.get('X-Tile-Fetch') ?? 'waiting for source data'}`, true, 30_000);
				},
				onState: (state: import('./worldRequests').RequestState) => {
					if (this.disposed) return;
					t.requestState = state;
					if (state === 'cancelled' || state === 'failed') {
						if (!this.wanted.includes(key)) {
							t.mesh?.geometry.dispose();
							(t.mesh?.material as THREE_NS.Material | undefined)?.dispose();
							t.tex?.dispose();
							this.tiles.delete(key);
						}
						else if (!t.h) t.state = 'failed';
					} else if (state !== 'loaded' && !t.h) t.state = 'loading';
					this.compose(); this.o.onChange?.();
				}
			};
		}));
		this.pumpOrtho();
	}

	/** the orthophoto for every wanted tile whose ground has loaded and which has no photo yet */
	private pumpOrtho() {
		const url = this.o.orthoUrl;
		if (!url) return;
		const want = this.wanted.filter((k) => {
			const t = this.tiles.get(k);
			return t?.state === 'ready' && t.mesh && t.ortho !== 'ready' && t.ortho !== 'none';
		});
		this.requests.reconcile(this.orthoScope, want.map((key, priority) => {
			const t = this.tiles.get(key)!;
			const { z, x, y } = t;
			// finer than the terrain only where the terrain stops splitting
			const dz = z >= this.o.maxZ ? Math.max(0, Math.min(2, this.o.orthoMaxZ - z)) : 0;
			return {
				id: key, label: `Orthophoto ${key}`, kind: 'ortho' as const,
				url: url.replace('{z}', String(z + dz)).replace('{x}', String(x << dz)).replace('{y}', String(y << dz)),
				priority, cacheable: true,
				run: async (signal: AbortSignal, requestId: string) => {
					t.ortho = 'loading';
					const canvas = await loadOrtho(url, z, x, y, dz, signal, requestId);
					signal.throwIfAborted();
					if (this.disposed) return;
					if (!canvas) { t.ortho = 'none'; return; }
					const tex = new this.THREE.CanvasTexture(canvas);
					tex.colorSpace = this.THREE.SRGBColorSpace;
					tex.premultiplyAlpha = true;          // groundMaterial blends by its alpha
					tex.anisotropy = 4;
					t.tex?.dispose();
					t.tex = tex; t.ortho = 'ready';
					if (t.mesh) drapeOrtho(t.mesh, tex);
					this.o.onChange?.();
				},
				onState: (state: import('./worldRequests').RequestState) => {
					if (this.disposed) return;
					// given up on: the height ramp stays; dropped from the view: asked again if wanted
					if (state === 'failed') t.ortho = 'none';
					else if (state === 'cancelled' && t.ortho === 'loading') t.ortho = undefined;
				}
			};
		}));
	}

	/** the ground's ellipsoidal height at a point, from the finest loaded tile with a value there */
	heightAt(lat: number, lon: number): number | null {
		for (let z = this.o.maxZ; z >= this.o.minZ; z--) {
			const [x, y] = tileOf(lat, lon, z);
			const t = this.tiles.get(`${z}/${x}/${y}` as TileKey);
			if (t?.state !== 'ready' || !t.h || !t.n) continue;
			const v = sampleTile(t.h, t.n, z, x, y, lat, lon);
			if (v !== null) return v;
		}
		return null;
	}

	/** what is on screen: every wanted tile that is ready, else its nearest ready ancestor */
	private compose() {
		const show = new Set<THREE_NS.Mesh>();
		for (const k of this.wanted) {
			let [z, x, y] = k.split('/').map(Number);
			let t = this.tiles.get(k);
			while ((!t || t.state !== 'ready') && z > this.o.minZ) {
				z--; x >>= 1; y >>= 1;
				t = this.tiles.get(`${z}/${x}/${y}` as TileKey);
			}
			if (t?.state === 'ready' && t.mesh) { show.add(t.mesh); t.used = this.tick; }
		}
		for (const c of [...this.group.children]) if (c !== this.globe && !show.has(c as THREE_NS.Mesh)) this.group.remove(c);
		for (const m of show) if (m.parent !== this.group) this.group.add(m);
	}

	/**
	 * Drop old tiles once the cache is well past what the view wants. Never a wanted tile, and never
	 * an ANCESTOR of one: they stand in while a tile loads, and selection reads its heights and its
	 * data's resolution from them. Evicting them (the cap was 600, below a zoomed view's 800) changed
	 * the next selection, which evicted others, and the ground reloaded for ever.
	 */
	private evict() {
		const cap = Math.max(600, Math.ceil(this.wanted.length * 1.5));
		if (this.tiles.size <= cap) return;
		const keep = new Set<string>();
		for (const k of this.wanted) {
			let [z, x, y] = k.split('/').map(Number);
			while (z >= this.o.minZ && !keep.has(`${z}/${x}/${y}`)) {
				keep.add(`${z}/${x}/${y}`);
				z--; x >>= 1; y >>= 1;
			}
		}
		const old = [...this.tiles.values()].filter((t) => t.state !== 'loading' && t.used < this.tick && !keep.has(t.key))
			.sort((a, b) => a.used - b.used);
		for (const t of old.slice(0, this.tiles.size - Math.round(cap * 0.85))) {
			t.mesh?.geometry.dispose();
			(t.mesh?.material as THREE_NS.Material | undefined)?.dispose();
			t.tex?.dispose();
			this.tiles.delete(t.key);
			this.requests.forget(this.requestScope, t.key);
			this.requests.forget(this.orthoScope, t.key);
		}
	}

	dispose() {
		this.disposed = true;
		this.requests.release(this.requestScope);
		this.requests.release(this.orthoScope);
		if (this.ownsRequests) this.requests.dispose();
		for (const t of this.tiles.values()) {
			t.mesh?.geometry.dispose();
			(t.mesh?.material as THREE_NS.Material | undefined)?.dispose();
			t.tex?.dispose();
		}
		this.tiles.clear();
		this.globe?.geometry.dispose();
		(this.globe?.material as THREE_NS.Material | undefined)?.dispose();
		this.group.removeFromParent();
	}
}
