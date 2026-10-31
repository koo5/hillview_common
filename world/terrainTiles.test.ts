import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Frame } from './geodesy';
import { selectMapTiles } from './footprintTiles';
import { budgetFor, buildTileMesh, decodeTile, fillHoles, finestRes, selectTiles, tileGrid, tileLonLat, tileOf, type View } from './terrainTiles';
import { maxDistance } from './worldLabels';

const frame = new Frame(50.1619, 14.614, 44.55);
// as the viewer selects: from the whole earth (zoom 0), as far as the horizon
const opts = { minZ: 0, maxZ: 16, pixelError: 6, maxTiles: 220, radiusM: Infinity };

describe('terrain tiles', () => {
	it('the grid is the API one: corners on the tile bounds, row 0 north', () => {
		const { lons, lats } = tileGrid(15, 17718, 11086);
		const b = tileLonLat(15, 17718, 11086);
		expect(lons[0]).toBeCloseTo(b.w, 12);
		expect(lats[0]).toBeCloseTo(b.n, 12);
		expect(lons[65 * 65 - 1]).toBeCloseTo(b.e, 12);
		expect(lats[65 * 65 - 1]).toBeCloseTo(b.s, 12);
		expect(tileOf(50.187, 14.661, 15)).toEqual([17718, 11086]);
	});

	it('fine under the camera, coarse far off, and capped', () => {
		const cam = frame.fromGeodetic(50.187, 14.661, 44.55 + 250);
		const sel = selectTiles(frame, cam, opts);
		expect(sel.length).toBeLessThanOrEqual(opts.maxTiles);
		const [x16, y16] = tileOf(50.187, 14.661, 16);
		expect(sel.some(([z, x, y]) => z === 16 && x === x16 && y === y16)).toBe(true);
		// 100 km away the ground is in coarse tiles
		const [x9, y9] = tileOf(49.3, 14.661, 9);
		const far = sel.filter(([z, x, y]) => x >> (z - 9) === x9 && y >> (z - 9) === y9);
		expect(far.length).toBeGreaterThan(0);
		expect(Math.max(...far.map(([z]) => z))).toBeLessThanOrEqual(10);
	});

	// the finest zoom chosen over a point, of a selection
	const zAt = (sel: [number, number, number][], lat: number, lon: number) =>
		Math.max(0, ...sel.filter(([z, x, y]) => {
			const [px, py] = tileOf(lat, lon, z);
			return px === x && py === y;
		}).map(([z]) => z));
	// standing on the town, 250 m up, looking due east at a ridge 30 km off
	const cam = frame.fromGeodetic(50.187, 14.661, 44.55 + 250);
	const ridge = { lat: 50.187, lon: 14.661 + 30_000 / 71_400 };
	const look = (fovY: number): View => ({ dir: [1, 0, 0], fovY, aspect: 1.6, heightPx: 1000 });

	it('zooming in on a ridge 30 km off draws it finer -- the wedge in view takes the budget', () => {
		// the ground as the loaded tiles know it: a plain round 235 m (ellipsoidal)
		const flat = () => [200, 280] as [number, number];
		const at = (fov: number) => selectTiles(frame, cam, { ...opts, maxTiles: budgetFor(opts.maxTiles, look(fov)) }, look(fov), flat);
		const wide = at(55), tele = at(0.5);
		// ~100-200 m cells: the base budget now covers the ground out to the horizon (~310 km here)
		expect(zAt(wide, ridge.lat, ridge.lon)).toBeLessThanOrEqual(12);
		expect(zAt(tele, ridge.lat, ridge.lon)).toBe(16);       // ~6 m: as fine as the 10 m data
		expect(wide.length).toBeLessThanOrEqual(opts.maxTiles);
		expect(tele.length).toBeLessThanOrEqual(2 * opts.maxTiles);
	});

	it('behind the camera the ground stays, coarser than in front', () => {
		const sel = selectTiles(frame, cam, opts, look(55), () => [200, 280]);
		const behind = { lat: 50.187, lon: 14.661 - 10_000 / 71_400 }, ahead = { lat: 50.187, lon: 14.661 + 10_000 / 71_400 };
		expect(zAt(sel, behind.lat, behind.lon)).toBeGreaterThan(0);
		expect(zAt(sel, behind.lat, behind.lon)).toBeLessThan(zAt(sel, ahead.lat, ahead.lon));
	});

	it('map tiles: the near disc as before; through a telephoto, the view out to where a house is still pixels', () => {
		const ground = () => 235;                                 // as the terrain tiles know it
		const near = selectMapTiles(frame, cam, 2500, 60, look(55), ground);
		const tele = selectMapTiles(frame, cam, 2500, 60, look(0.5), ground);
		const [rx, ry] = tileOf(ridge.lat, ridge.lon, 15);
		expect(near.some(([x, y]) => x === rx && y === ry)).toBe(false);
		expect(tele.some(([x, y]) => x === rx && y === ry)).toBe(true);
		// from 6 km up there are no street-level tiles to ask for
		expect(selectMapTiles(frame, frame.fromGeodetic(50.187, 14.661, 6000), 2500, 60, look(55))).toEqual([]);
	});

	it('from the whole earth to the horizon: high up, the far side of the planet is not asked for', () => {
		// 1,000 km above the town, looking down: tiles reach ~3,800 km and no further
		const high = frame.fromGeodetic(50.187, 14.661, 1_000_000);
		const down: View = { dir: [0, 0, -1], fovY: 55, aspect: 1.6, heightPx: 1000 };
		const sel = selectTiles(frame, high, opts, down, () => [0, 300]);
		expect(sel.length).toBeGreaterThan(10);
		const far = sel.filter(([z, x, y]) => {
			const b = tileLonLat(z, x, y);
			return Math.abs((b.w + b.e) / 2 - 14.661) > 90 && b.e - b.w < 90;   // a tile on the other side
		});
		expect(far).toEqual([]);
		// from the ground, the horizon is ~310 km: nothing is asked 600 km off
		const sel2 = selectTiles(frame, cam, opts, look(55), () => [200, 280]);
		const centre = (t: number[]) => { const b = tileLonLat(t[0], t[1], t[2]); return frame.fromGeodetic((b.n + b.s) / 2, (b.w + b.e) / 2, 0); };
		const sizes = sel2.map((t) => { const c = centre(t), b = tileLonLat(t[0], t[1], t[2]); return [Math.hypot(c[0] - cam[0], c[1] - cam[1]), (b.e - b.w) * 71_400] as const; });
		expect(sizes.every(([d, w]) => d - w < 600_000)).toBe(true);
	});

	it('no finer than the data: 2 m ČÚZK down to zoom 18, 10 m to 16, GLO-30 to 14', () => {
		const flat = () => [200, 280] as [number, number];
		const o = { ...opts, maxZ: 18, pixelError: 3, maxTiles: 440 };
		const finest = (res: number) => Math.max(...selectTiles(frame, cam, o, look(0.5), flat, () => res).map(([z]) => z));
		expect(finest(2)).toBe(18);
		expect(finest(10)).toBe(16);
		expect(finest(30)).toBe(14);
	});

	it('decodes both wire formats: float32, and q16 decimetre deltas with holes', () => {
		const n = 3;
		// q16 as api encode_q16 writes it: heights 100.0 100.5 99.8 / 101.2 (hole) 101.0 / ...
		const want = [100, 100.5, 99.8, 101.2, NaN, 101, 102, 102.3, 102.1];
		const src = [2, 2, 2, 2, 0, 2, 4, 4, 4];
		const base = 99.8;
		const filled = want.map((v, i) => (Number.isNaN(v) ? want[i - 1] : v));
		const q = filled.map((v) => Math.round((v - base) * 10));
		const d: number[] = [];
		for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
			d.push(c ? q[r * n + c] - q[r * n + c - 1] : r ? q[r * n] - q[(r - 1) * n] : q[0]);
		const buf = new ArrayBuffer(12 + 3 * n * n);
		new Uint8Array(buf).set([72, 86, 81, 49]);
		new DataView(buf).setFloat64(4, base, true);
		new Int16Array(buf, 12, n * n).set(d);
		new Uint8Array(buf, 12 + 2 * n * n).set(src);
		const t = decodeTile(buf, 'q16');
		expect(t.n).toBe(3);
		want.forEach((v, i) => (Number.isNaN(v) ? expect(t.h[i]).toBeNaN() : expect(t.h[i]).toBeCloseTo(v, 4)));
		expect(finestRes(t.src)).toBe(2);
		const f = new ArrayBuffer(5 * n * n);
		new Float32Array(f, 0, n * n).set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		new Uint8Array(f, 4 * n * n).fill(3);
		const g = decodeTile(f, null, n);
		expect(Array.from(g.h)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(finestRes(g.src)).toBe(30);
	});

	it("the map's names reach further through a telephoto; peaks keep their caps", () => {
		expect(maxDistance('residential', 1)).toBe(1500);
		expect(maxDistance('residential', 10)).toBe(15_000);
		expect(maxDistance('residential', 110)).toBe(30_000);
		expect(maxDistance('peak', 110)).toBe(120_000);
	});

	it('a tile mesh is its vertices where geodesy puts them, relative to its own centre', () => {
		const n = 65, z = 15, [x, y] = tileOf(50.187, 14.661, 15);
		const h = new Float32Array(n * n).fill(260);
		h[100] = NaN;
		const m = buildTileMesh(THREE, frame, z, x, y, h, n)!;
		const pos = m.geometry.getAttribute('position');
		const { lons, lats } = tileGrid(z, x, y, n);
		for (const i of [0, 64, 2000, 4224]) {
			const want = frame.fromGeodetic(lats[i], lons[i], 260);
			expect(pos.getX(i) + m.position.x).toBeCloseTo(want[0], 2);
			expect(pos.getY(i) + m.position.y).toBeCloseTo(want[1], 2);
			expect(pos.getZ(i) + m.position.z).toBeCloseTo(want[2], 2);
		}
		// small local numbers, which float32 keeps to the millimetre
		expect(Math.abs(pos.getX(0))).toBeLessThan(2000);
		// a one-sample hole is filled from its neighbours and drawn, not left open
		const idx = m.geometry.getIndex()!.array;
		expect(Array.from(idx).includes(100)).toBe(true);
		expect(pos.getZ(100) + m.position.z).toBeCloseTo(frame.fromGeodetic(lats[100], lons[100], 260)[2], 1);
		// and a tile with no ground at all makes no mesh
		expect(buildTileMesh(THREE, frame, z, x, y, new Float32Array(n * n).fill(NaN), n)).toBeNull();
	});

	it('fills a hole ring by ring from its edge, marks it, and leaves a hole too wide alone', () => {
		const n = 9;
		const h = new Float32Array(n * n).fill(100);
		for (let r = 3; r <= 5; r++) for (let c = 3; c <= 5; c++) h[r * n + c] = NaN;
		const f = fillHoles(h, n, 24);
		expect(Number.isFinite(f.h[4 * n + 4])).toBe(true);
		expect(f.h[4 * n + 4]).toBeCloseTo(100, 6);
		expect(f.mask[4 * n + 4]).toBe(1);
		expect(f.mask[0]).toBe(0);
		const wide = new Float32Array(n * n).fill(NaN);
		wide[0] = 5;
		const g = fillHoles(wide, n, 2);
		expect(Number.isFinite(g.h[2 * n + 2])).toBe(true);
		expect(Number.isFinite(g.h[n * n - 1])).toBe(false);
	});
});
