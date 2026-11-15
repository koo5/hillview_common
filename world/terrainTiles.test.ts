import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Frame } from './geodesy';
import { selectMapTiles } from './footprintTiles';
import { TerrainTiles, budgetFor, buildTileMesh, decodeTile, drapeOrtho, photoDz, screenSizePx, fillHoles, finestRes, selectTiles, tileGrid, tileLonLat, tileOf, type View } from './terrainTiles';
import { maxDistance } from './worldLabels';
import { WorldRequests } from './worldRequests';

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

	it('the ground keeps the ramp and the hillshade, and blends a draped photo by its alpha (ea09)', () => {
		const n = 65, z = 15, [x, y] = tileOf(50.187, 14.661, 15);
		const m = buildTileMesh(THREE, frame, z, x, y, new Float32Array(n * n).fill(260), n)!;
		const g = m.geometry, ramp = g.getAttribute('color').array.slice();
		expect(g.getAttribute('shade').count).toBe(g.getAttribute('color').count);
		// draping a photo leaves both colour sets as they are: the shader picks per pixel
		drapeOrtho(m, new THREE.Texture());
		expect(Array.from(g.getAttribute('color').array)).toEqual(Array.from(ramp));
		// three's own basic shader, through the hook: every chunk it replaces is there (an upgrade that renamed
		// one would leave the photo multiplied over black again, without an error)
		const mat = m.material as THREE.MeshBasicMaterial;
		const sh = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader,
			uniforms: {}, defines: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
		mat.onBeforeCompile(sh, {} as THREE.WebGLRenderer);
		expect(sh.vertexShader).toContain('vShade = shade;');
		expect(sh.fragmentShader).toContain('varying vec3 vShade;');
		expect(sh.fragmentShader).not.toContain('#include <map_fragment>');
		expect(sh.fragmentShader).not.toContain('#include <color_fragment>');
		expect(sh.fragmentShader).toContain('vColor.rgb * ( 1.0 - photo.a ) + photo.rgb * vShade');
		expect(mat.customProgramCacheKey()).toBe('world-ground');
	});

	it('a tile is as big on screen as the area it covers: a far one seen from the ground is a sliver, a zoom enlarges it', () => {
		// standing 2 m over the ground at the frame's origin, looking north and level
		const cam = frame.fromGeodetic(frame.lat, frame.lon, frame.h + 2);
		const north = frame.fromGeodetic(frame.lat + 0.001, frame.lon, frame.h + 2);
		const dir = [north[0] - cam[0], north[1] - cam[1], north[2] - cam[2]] as [number, number, number];
		const view = { dir, fovY: 55, aspect: 1.6, heightPx: 800 };
		const [nx, ny] = tileOf(frame.lat, frame.lon, 16);
		const under = screenSizePx(frame, cam, view, 16, nx, ny, frame.h);                    // standing in it
		expect(under).toBeGreaterThan(Math.sqrt(800 * 1.6 * 800));                         // its part on screen, scaled to the whole
		const z = 13, [fx, fy] = tileOf(frame.lat + 0.2, frame.lon, z);                      // ~22 km north
		const far = screenSizePx(frame, cam, view, z, fx, fy, frame.h);
		expect(far).toBeGreaterThan(2);
		expect(far).toBeLessThan(48);                                                     // a sliver
		const zoomed = screenSizePx(frame, cam, { ...view, fovY: 4 }, z, fx, fy, frame.h);
		expect(zoomed).toBeGreaterThan(far * 10);                                        // zoomed in, far bigger
		const [bx, by] = tileOf(frame.lat - 0.2, frame.lon, z);                            // behind the camera
		expect(screenSizePx(frame, cam, view, z, bx, by, frame.h)).toBe(0);
	});

	it('the photo follows the screen: its own at 256 px and up, a coarser one shared below, none under 2 px', () => {
		expect(photoDz(15, 3000, 18, 20)).toBe(0);
		expect(photoDz(18, 300, 18, 20)).toBe(0);                 // at maxZ, the finer mosaic only as big as it shows
		expect(photoDz(18, 600, 18, 20)).toBe(1);
		expect(photoDz(18, 2000, 18, 20)).toBe(2);
		expect(photoDz(18, Infinity, 18, 20)).toBe(2);            // standing in it
		expect(photoDz(19, 2000, 18, 20)).toBe(1);                // never past orthoMaxZ
		expect(photoDz(18, 255, 18, 20)).toBe(-1);
		expect(photoDz(18, 20, 18, 20)).toBe(-4);                 // 256 / 20 -> 4 levels up: a 16 px part of a z14 photo
		expect(photoDz(9, 1.5, 18, 20)).toBeNull();
		expect(photoDz(8, 3, 18, 20)).toBe(-2);                   // never coarser than z6
		expect(photoDz(6, 3, 18, 20)).toBe(-0);
	});

	it('a re-layout carries a built tile: its vertices land where the same tile built in the new frame has them', () => {
		const a = new Frame(50.0875, 14.4214, 0), b = new Frame(50.0, 14.68, 0);     // ~20 km apart
		const n = 65, z = 15, [x, y] = tileOf(50.05, 14.55, z);
		const h = new Float32Array(n * n).fill(300);
		const tt = new TerrainTiles(THREE, { tileUrl: 'http://e/{z}/{x}/{y}', frame: a, requests: new WorldRequests(), globe: false });
		const mesh = buildTileMesh(THREE, a, z, x, y, h, n)!;
		(tt as unknown as { tiles: Map<string, object> }).tiles.set(`${z}/${x}/${y}`, { key: `${z}/${x}/${y}`, z, x, y, state: 'ready', mesh, used: 0 });
		tt.setFrame(b);
		const want = buildTileMesh(THREE, b, z, x, y, h, n)!;
		mesh.updateMatrixWorld(true); want.updateMatrixWorld(true);
		const pa = mesh.geometry.getAttribute('position'), pb = want.geometry.getAttribute('position');
		for (const i of [0, 64, 2112, 4224]) {
			const va = new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(mesh.matrixWorld);
			const vb = new THREE.Vector3().fromBufferAttribute(pb, i).applyMatrix4(want.matrixWorld);
			expect(va.distanceTo(vb)).toBeLessThan(0.01);
		}
		expect(tt.o.frame).toBe(b);
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

describe('a loading tile is stood in for by what is loaded there (ea15)', () => {
	type Internals = { tiles: Map<string, object>; wanted: string[]; tick: number; compose(): void; pump(): void };
	const z = 12, x = 2210, y = 1388;
	const key = (zz: number, xx: number, yy: number) => `${zz}/${xx}/${yy}`;
	const children = (zz: number, xx: number, yy: number): [number, number, number][] =>
		[[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => [zz + 1, 2 * xx + a, 2 * yy + b]);
	/** a scene whose loaded tiles are `ready`, wanting `wanted`. A ready tile `bare` has no heights (no mesh), and
	 * earth said so (complete); one `empty` came incomplete with none (earth still fetching its source data) */
	const scene = (wanted: [number, number, number][], ready: [number, number, number][], bare: [number, number, number][] = [],
		empty: [number, number, number][] = []) => {
		const tt = new TerrainTiles(THREE, { tileUrl: 'http://e/{z}/{x}/{y}', frame, requests: new WorldRequests(), globe: false });
		const inner = tt as unknown as Internals;
		const meshes = new Map<string, THREE.Mesh>();
		for (const [zz, xx, yy] of [...ready, ...bare, ...empty]) {
			const mesh = ready.some((r) => r.join() === [zz, xx, yy].join()) ? new THREE.Mesh() : undefined;
			if (mesh) meshes.set(key(zz, xx, yy), mesh);
			const complete = !empty.some((r) => r.join() === [zz, xx, yy].join());
			inner.tiles.set(key(zz, xx, yy), { key: key(zz, xx, yy), z: zz, x: xx, y: yy, state: 'ready', mesh, complete, used: 0 });
		}
		for (const [zz, xx, yy] of wanted) if (!inner.tiles.has(key(zz, xx, yy)))
			inner.tiles.set(key(zz, xx, yy), { key: key(zz, xx, yy), z: zz, x: xx, y: yy, state: 'loading', used: 0 });
		inner.wanted = wanted.map((w) => key(...w));
		inner.tick = 1;
		inner.compose();
		const drawn = tt.group.children.map((c) => [...meshes].find(([, m]) => m === c)?.[0]).sort();
		return { tt, inner, drawn };
	};
	const kids = children(z, x, y);
	const ancestor: [number, number, number] = [z - 2, x >> 2, y >> 2];

	it('by its finer tiles when they cover it (they are drawn already: no pop), before a coarser ancestor', () => {
		expect(scene([[z, x, y]], [...kids, ancestor]).drawn).toEqual(kids.map((k) => key(...k)).sort());
		// two levels down: three children and the fourth's four children cover it whole
		const grand = children(...kids[3]);
		expect(scene([[z, x, y]], [...kids.slice(0, 3), ...grand, ancestor]).drawn)
			.toEqual([...kids.slice(0, 3), ...grand].map((k) => key(...k)).sort());
		// a ready child with no heights covers its part too: that ground is known to be empty
		expect(scene([[z, x, y]], [...kids.slice(0, 3), ancestor], [kids[3]]).drawn).toEqual(kids.slice(0, 3).map((k) => key(...k)).sort());
	});

	it('by its nearest loaded ancestor when the finer ones leave a gap, and by those finer ones when nothing else is', () => {
		expect(scene([[z, x, y]], [...kids.slice(0, 3), ancestor]).drawn).toEqual([key(...ancestor)]);
		// the ancestor stands in for that whole loading tile: no finer tile under it is drawn too
		expect(scene([[z, x, y]], [...kids.slice(0, 3)]).drawn).toEqual(kids.slice(0, 3).map((k) => key(...k)).sort());
		// its own ground once it is in, and nothing in its place
		expect(scene([[z, x, y]], [[z, x, y], ...kids, ancestor]).drawn).toEqual([key(z, x, y)]);
	});

	it('a tile served incomplete with no heights knows nothing yet: it never takes the place of drawn ground', () => {
		// the wanted tile itself: the ancestor's ground stays until real heights come (main drew nothing there)
		expect(scene([[z, x, y]], [ancestor], [], [[z, x, y]]).drawn).toEqual([key(...ancestor)]);
		// a finer one: it does not complete the cover, so the ancestor stands in, not three children and a hole
		expect(scene([[z, x, y]], [...kids.slice(0, 3), ancestor], [], [kids[3]]).drawn).toEqual([key(...ancestor)]);
		// complete and empty is knowledge: no ground there, nothing drawn in its place
		expect(scene([[z, x, y]], [ancestor], [[z, x, y]]).drawn).toEqual([]);
	});

	it('a stand-in is marked used, so evict() keeps it while it stands in', () => {
		const { inner } = scene([[z, x, y]], [...kids]);
		for (const k of kids) expect((inner.tiles.get(key(...k)) as { used: number }).used).toBe(1);
	});

	it('an incomplete tile split into its children stays drawn for them until they are in (Ground 2)', async () => {
		const real = globalThis.fetch;
		const n = 65, buf = new ArrayBuffer(5 * n * n);
		new Float32Array(buf, 0, n * n).fill(300);
		new Uint8Array(buf, 4 * n * n, n * n).fill(1);
		let served!: () => void;
		const parentIn = new Promise<void>((r) => (served = r));
		globalThis.fetch = ((u: string, init: RequestInit) => {
			// the parent: in, but incomplete (earth is still fetching its source data); the children never answer
			if (u === `http://e/${key(z, x, y)}`) {
				setTimeout(served, 0);
				return Promise.resolve(new Response(buf, { headers: { 'X-Tile-Complete': '0', 'X-Tile-Format': 'f32' } }));
			}
			return new Promise((_, no) => init.signal?.addEventListener('abort', () => no(init.signal?.reason)));
		}) as typeof fetch;
		const requests = new WorldRequests();
		try {
			const tt = new TerrainTiles(THREE, { tileUrl: 'http://e/{z}/{x}/{y}', frame, requests, globe: false });
			const inner = tt as unknown as Internals;
			inner.wanted = [key(z, x, y)];
			inner.pump();
			await parentIn;
			await new Promise((r) => setTimeout(r, 0));
			const parent = inner.tiles.get(key(z, x, y)) as { state: string; mesh?: THREE.Mesh; complete?: boolean };
			expect([parent.state, parent.complete, !!parent.mesh]).toEqual(['ready', false, true]);
			// the selection splits it: its retry is cancelled, and it stands in for the four children loading
			inner.wanted = kids.map((k) => key(...k));
			inner.pump();
			inner.compose();
			expect(inner.tiles.get(key(z, x, y))).toBe(parent);
			expect(tt.group.children).toEqual([parent.mesh]);
			tt.dispose();
		} finally {
			requests.dispose();
			globalThis.fetch = real;
		}
	});
});
