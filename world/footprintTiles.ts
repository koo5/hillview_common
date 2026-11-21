/**
 * OpenStreetMap round the camera, tile by tile (2026-10-01): what terrainTiles.ts does for the
 * ground, for buildings, roads and water. The map used to be one 800 m circle per solve; this is
 * the map wherever the camera goes.
 *
 * Tiles are /map/tile/15/{x}/{y}.json (api routers/terrain.py): every vertex as lat, lon and an
 * ELLIPSOIDAL height (bare earth + N), placed here by geodesy.ts into the scene's frame -- the
 * same exact step as the terrain and the solves -- and stored relative to the tile's centre.
 *
 * Drawn as the per-solve map draws them, so the two read alike: buildings as wireframes coloured
 * by where their height came from (a default is a guess and must not look surveyed), translucent
 * walls, a flat roof at the footprint's mean ground plus its height; roads, walls and water as
 * lines lifted a little off the ground.
 *
 * Overpass is a shared service: a refused tile (503) is retried by the desired-data scheduler, not drawn empty.
 *
 * The same drawing reads earth's OpenStreetMap vector tiles too (format 'mvt': a channel's `osm` release, the public
 * scene's buildings outside the city models). Those carry no heights, so each building stands on the terrain the
 * scene draws (`ground`: its height and tile zoom at a point): a tile waits until the terrain answers under every
 * vertex, and is built again when finer terrain arrives at its centre. Buildings only: the public scene draws no
 * roads or water from them.
 */
import type * as THREE_NS from 'three';
import { Frame, rigid, type Vec3 } from './geodesy';
import { decodeMvt, mvtBuildings, type FlatBuilding } from './mvt';
import { WorldRequests, responseOrThrow, requestHeaders } from './worldRequests';
import { REF_VIEW, inFrustum, pxPerRad, tileLonLat, tileOf, type View } from './terrainTiles';

type Three = typeof THREE_NS;
type V = [number, number, number];
type Line = { id?: number; line: V[] };
export type MapTile = {
	z: number; x: number; y: number;
	buildings: { id?: number; ring: V[]; height_m?: number; height_source?: string }[];
	roads: Line[]; walls: Line[]; water: (Line & { area?: boolean })[];
	/** one per named way per tile, at the midpoint of its longest segment (api: _tile_labels) */
	labels?: { name: string; kind: string; at: [number, number, number | null]; len_m: number }[];
};

/** a map tile's name, placed in the world frame, a little above the ground it names */
export type TileLabel = { id: string; name: string; kind: string; p: Vec3; len: number };
const LABEL_LIFT_M = 3;

const Z = 15;
const COLOURS = { height: 0xff9a2e, levels: 0xd08a44, default: 0x7a6a55 } as const;

/** the building a map tile is worth loading for: this tall, at least MIN_PX on screen */
const BUILDING_M = 10;
const MIN_PX = 3;
/** however far a telephoto reaches, map tiles stop here (zoom 15 tiles are ~800 m) */
const REACH_MAX_M = 30_000;

/**
 * The map tiles to draw (2026-10-02): every tile within `radiusM` of the camera, and, IN VIEW,
 * every tile out to where a BUILDING_M building still covers MIN_PX at the view's magnification --
 * ~3 km at an ordinary field of view, the 30 km cap through a telephoto. Distances are from the
 * camera itself, height included, so from high above nothing street-level is asked for. In view
 * comes first, nearest first; then the rest, up to `max`.
 */
export function selectMapTiles(frame: Frame, cam: Vec3, radiusM: number, max: number, view?: View,
	/** the ground's ellipsoidal height at a point, if known (the terrain tiles') */
	groundAt?: (lat: number, lon: number) => number | null): [number, number][] {
	const k = pxPerRad(view ?? REF_VIEW);
	const reach = view ? Math.min(REACH_MAX_M, Math.max(radiusM, (BUILDING_M * k) / MIN_PX)) : radiusM;
	const [lat, lon] = frame.toGeodetic(...cam);
	const dLat = reach / 111_000, dLon = reach / (111_000 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
	const [x0, y0] = tileOf(lat + dLat, lon - dLon, Z);
	const [x1, y1] = tileOf(lat - dLat, lon + dLon, Z);
	const out: { x: number; y: number; d: number; inView: boolean }[] = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
		const b = tileLonLat(Z, x, y);
		const ground = groundAt?.((b.n + b.s) / 2, (b.w + b.e) / 2) ?? null;
		const c = frame.fromGeodetic((b.n + b.s) / 2, (b.w + b.e) / 2, ground ?? frame.h);
		const to = [c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]];
		const d = Math.hypot(to[0], to[1], to[2]);
		// in view: the tile as a box from its centre's ground down/up by what a town can span
		const inView = !!view && d > 1 && d <= reach + 600 && inFrustum([b.n, b.s].flatMap((la) => [b.w, b.e].flatMap((lo) =>
			[frame.fromGeodetic(la, lo, (ground ?? frame.h) - 50), frame.fromGeodetic(la, lo, (ground ?? frame.h) + 150)])), cam, view);
		if (d <= radiusM + 600 || (inView && d <= reach + 600)) out.push({ x, y, d, inView });
	}
	return out.sort((a, b) => Number(b.inView) - Number(a.inView) || a.d - b.d).slice(0, max).map((t) => [t.x, t.y]);
}

/** One tile's map as a group of merged line sets and one translucent wall mesh. */
export function buildMapTile(THREE: Three, frame: Frame, t: MapTile, replaced = new Set<string>()): THREE_NS.Group {
	const b = tileLonLat(t.z, t.x, t.y);
	const centre = frame.fromGeodetic((b.n + b.s) / 2, (b.w + b.e) / 2, frame.h);
	const at = (lat: number, lon: number, h: number): V => {
		const w = frame.fromGeodetic(lat, lon, h);
		return [w[0] - centre[0], w[1] - centre[1], w[2] - centre[2]];
	};
	const grp = new THREE.Group();
	grp.position.set(centre[0], centre[1], centre[2]);
	const edges: Record<string, number[]> = { height: [], levels: [], default: [] };
	const faces: number[] = [];
	for (const bd of t.buildings ?? []) {
		if (replaced.has(`way/${bd.id}`)) continue;
		const ring = bd.ring;
		if (ring.length < 3) continue;
		const mean = ring.reduce((s, v) => s + v[2], 0) / ring.length;
		const top = mean + (bd.height_m ?? 7);
		const base = ring.map((v) => at(v[0], v[1], v[2]));
		const roof = ring.map((v) => at(v[0], v[1], top));
		const bucket = edges[bd.height_source ?? 'default'] ?? edges.default;
		for (let i = 0; i + 1 < ring.length; i++) {
			const g0 = base[i], g1 = base[i + 1], r0 = roof[i], r1 = roof[i + 1];
			bucket.push(...g0, ...g1, ...r0, ...r1, ...g0, ...r0);
			faces.push(...g0, ...g1, ...r1, ...g0, ...r1, ...r0);
		}
	}
	for (const [k, arr] of Object.entries(edges)) {
		if (!arr.length) continue;
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
		grp.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COLOURS[k as keyof typeof COLOURS] })));
	}
	if (faces.length) {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(faces), 3));
		grp.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({
			color: 0x6b4a1f, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false
		})));
	}
	const lines = (items: Line[] | undefined, colour: number, lift: number) => {
		const arr: number[] = [];
		for (const it of items ?? []) {
			for (let i = 0; i + 1 < it.line.length; i++) {
				const a = it.line[i], c = it.line[i + 1];
				arr.push(...at(a[0], a[1], a[2] + lift), ...at(c[0], c[1], c[2] + lift));
			}
		}
		if (!arr.length) return;
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
		grp.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: colour })));
	};
	lines(t.water, 0x2f8fd8, 0.15);
	lines(t.walls, 0x4fa8d8, 1.0);
	lines(t.roads, 0x46d6a0, 0.25);
	grp.userData.tile = `${t.z}/${t.x}/${t.y}`;
	return grp;
}

/** format 'mvt': the main thread's time per frame for standing tiles on the ground. A dense town tile (~700 buildings,
 * ~5,000 vertices) takes ~6 ms to build on a desktop and several times that on a phone; at least one per frame */
const GROUND_BUDGET_MS = 8;

/** a place another layer already draws buildings over (a city model's plan circle): footprints there are left out */
export type PlanCircle = { lat: number; lon: number; radius: number };

/** the ground at a point as the terrain says it: ellipsoidal height, and the zoom of the tile that answered */
export type GroundAt = (lat: number, lon: number) => { h: number; z: number } | null;

const metres = (lat0: number, lon0: number, lat1: number, lon1: number) => {
	const k = 111_320, c = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
	return Math.hypot((lat1 - lat0) * k, (lon1 - lon0) * k * c);
};

/**
 * One vector tile's footprints stood on the ground (format 'mvt'): each vertex at the terrain's height under it, the
 * buildings whose centroid lies inside one of `hidden` left out. Null while the terrain cannot answer under the tile's
 * centre or any vertex: the tile waits for it. `groundZ` is the terrain zoom that answered at the centre, so a finer
 * one arriving later can build it again.
 */
export function groundedTile(z: number, x: number, y: number, flat: FlatBuilding[], ground: GroundAt,
	hidden: PlanCircle[]): { tile: MapTile; groundZ: number } | null {
	const b = tileLonLat(z, x, y);
	const centre = ground((b.n + b.s) / 2, (b.w + b.e) / 2);
	if (!centre) return null;
	// only the circles that reach this tile are tested building by building
	const near = hidden.filter((c) => {
		const dLat = c.radius / 111_320, dLon = c.radius / (111_320 * Math.max(0.1, Math.cos((c.lat * Math.PI) / 180)));
		return c.lat + dLat >= b.s && c.lat - dLat <= b.n && c.lon + dLon >= b.w && c.lon - dLon <= b.e;
	});
	const buildings: MapTile['buildings'] = [];
	for (const f of flat) {
		const n = f.ring.length - 1;
		let la = 0, lo = 0;
		for (let i = 0; i < n; i++) { la += f.ring[i][0]; lo += f.ring[i][1]; }
		la /= n; lo /= n;
		if (near.some((c) => metres(la, lo, c.lat, c.lon) < c.radius)) continue;
		const ring: V[] = [];
		for (const [lat, lon] of f.ring) {
			const g = ground(lat, lon);
			if (!g) return null;
			ring.push([lat, lon, g.h]);
		}
		buildings.push({ id: f.id, ring, height_m: f.height_m, height_source: f.height_source });
	}
	return { tile: { z, x, y, buildings, roads: [], walls: [], water: [] }, groundZ: centre.z };
}

type Entry = { key: string; state: 'loading' | 'ready' | 'failed'; group?: THREE_NS.Group; data?: MapTile; labels?: TileLabel[];
	used: number;
	/** format 'mvt': the tile's footprints as read, and the terrain zoom its built group stood on */
	flat?: FlatBuilding[]; groundZ?: number };

export class FootprintTiles {
	readonly group: THREE_NS.Group;
	private tiles = new Map<string, Entry>();
	private wanted: string[] = [];
	private requests: WorldRequests;
	private requestScope: string;
	private ownsRequests: boolean;
	private tick = 0;
	private disposed = false;
	private replaced = new Set<string>();
	setReplaced(next: Set<string>) {
		if (next.size === this.replaced.size && [...next].every(k => this.replaced.has(k))) return;
		const changed = new Set([...next].filter(k => !this.replaced.has(k)));
		for (const key of this.replaced) if (!next.has(key)) changed.add(key);
		this.replaced = next;
		let rebuilt = false;
		for (const tile of this.tiles.values()) if (tile.data?.buildings.some(b => changed.has(`way/${b.id}`))) {
			tile.group?.removeFromParent(); disposeGroup(tile.group);
			tile.group = buildMapTile(this.THREE, this.o.frame, tile.data, this.replaced);
			rebuilt = true;
		}
		if (rebuilt) { this.version++; this.compose(); this.o.onChange?.(); }
	}
	/** format 'mvt': where another layer draws buildings (city models' plan circles); null while that is not known
	 * yet, and then no tile is built, so a footprint never shows for a moment under a city model */
	private hidden: PlanCircle[] | null = null;
	setHidden(next: PlanCircle[] | null) {
		if (next === this.hidden) return;
		this.hidden = next;
		if (next === null) return;
		for (const t of this.tiles.values()) if (t.flat) t.groundZ = undefined;   // built again by the next update
	}
	/** bumped whenever a tile becomes ready */
	version = 0;

	constructor(
		private THREE: Three,
		private o: {
			/** 'json': the workbench's /map/tile (heights included); 'mvt': earth's OSM vector tiles, stood on `ground` */
			format: 'json' | 'mvt';
			tileUrl: string; frame: Frame; radiusM?: number; maxTiles?: number; requests?: WorldRequests;
			groundAt?: (lat: number, lon: number) => number | null;
			/** format 'mvt': the terrain's height and zoom at a point */
			ground?: GroundAt;
			onChange?: () => void }
	) {
		if (o.format === 'mvt' && !o.ground) throw new Error('footprints: vector tiles carry no heights, so they need `ground`');
		this.group = new THREE.Group();
		this.group.name = 'footprints';
		this.requests = o.requests ?? new WorldRequests();
		this.ownsRequests = !o.requests;
		this.requestScope = this.requests.scope('map');
	}

	/** the scene was laid out about another origin: the built tiles carried there in one rigid move (cityModelTiles') */
	setFrame(next: Frame) {
		if (next === this.o.frame) return;
		const m = new this.THREE.Matrix4().set(...(rigid(this.o.frame, next) as Parameters<THREE_NS.Matrix4['set']>));
		for (const t of this.tiles.values()) t.group?.applyMatrix4(m);
		this.o.frame = next;
	}

	/** format 'mvt': each wanted tile read but not yet standing on finer ground than now answers at its centre, nearest
	 * first, GROUND_BUDGET_MS of them per frame; while more wait, another frame is asked for */
	private ground() {
		const ground = this.o.ground, hidden = this.hidden;
		if (!ground || hidden === null) return;
		const t0 = performance.now();
		let built = false, more = false;
		for (const k of this.wanted) {
			const t = this.tiles.get(k);
			if (!t?.flat) continue;
			const [z, x, y] = k.split('/').map(Number);
			if (t.group && t.groundZ !== undefined) {
				const b = tileLonLat(z, x, y);
				const now = ground((b.n + b.s) / 2, (b.w + b.e) / 2);
				if (!now || now.z <= t.groundZ) continue;
			}
			if (built && performance.now() - t0 > GROUND_BUDGET_MS) { more = true; break; }
			const g = groundedTile(z, x, y, t.flat, ground, hidden);
			if (!g) continue;
			t.group?.removeFromParent(); disposeGroup(t.group);
			t.group = buildMapTile(this.THREE, this.o.frame, g.tile);
			t.groundZ = g.groundZ;
			t.labels = [];
			t.state = 'ready';
			built = true;
		}
		if (built) this.version++;
		if (more) this.o.onChange?.();
	}

	get stats() {
		let ready = 0, loading = 0, failed = 0;
		for (const k of this.wanted) {
			const t = this.tiles.get(k);
			if (t?.state === 'ready') ready++;
			else if (t?.state === 'failed') failed++;
			else loading++;
		}
		return { wanted: this.wanted.length, ready, loading, failed };
	}

	/** settled once nothing it wants is still in flight (a refused tile counts as answered) */
	get settled() {
		return this.stats.loading === 0;
	}

	update(cam: Vec3, view?: View) {
		if (this.disposed) return;
		this.tick++;
		const sel = selectMapTiles(this.o.frame, cam, this.o.radiusM ?? 2500, this.o.maxTiles ?? 60, view, this.o.groundAt);
		this.wanted = sel.map(([x, y]) => `${Z}/${x}/${y}`);
		for (const k of this.wanted) {
			const t = this.tiles.get(k);
			if (t) t.used = this.tick;
		}
		this.pump();
		this.ground();
		this.compose();
		this.evict();
	}

	private pump() {
		this.requests.reconcile(this.requestScope, this.wanted.map((key, priority) => {
			const [z, x, y] = key.split('/').map(Number);
			const t: Entry = this.tiles.get(key) ?? { key, state: 'loading', used: this.tick };
			this.tiles.set(key, t);
			const url = this.o.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
			return {
				id: key, label: `OpenStreetMap ${key}`, kind: 'map' as const, url, priority, cacheable: true,
				run: async (signal: AbortSignal, requestId: string) => {
					const r = await responseOrThrow(url, signal, { headers: requestHeaders(url, undefined, requestId) });
					if (this.o.format === 'mvt') {
						// stood on the ground by the next update, once the terrain answers under it (ground())
						const flat = mvtBuildings(decodeMvt(new Uint8Array(await r.arrayBuffer())), z, x, y);
						signal.throwIfAborted();
						if (this.disposed) return;
						t.flat = flat;
						t.groundZ = undefined;
						return;
					}
					const d = await r.json() as MapTile;
					signal.throwIfAborted();
					if (this.disposed) return;
					t.data = d;
					t.group = buildMapTile(this.THREE, this.o.frame, d, this.replaced);
					t.labels = (d.labels ?? []).filter((l) => l.at[2] != null).map((l) => ({
						id: `${key}|${l.kind}|${l.name}`, name: l.name, kind: l.kind, len: l.len_m,
						p: this.o.frame.fromGeodetic(l.at[0], l.at[1], (l.at[2] as number) + LABEL_LIFT_M)
					}));
					t.state = 'ready'; this.version++;
				},
				onState: (state: import('./worldRequests').RequestState) => {
					if (this.disposed) return;
					if (state === 'cancelled' || state === 'failed') {
						if (!this.wanted.includes(key)) { disposeGroup(t.group); this.tiles.delete(key); }
						else t.state = 'failed';
					} else if (state !== 'loaded') t.state = 'loading';
					this.compose(); this.o.onChange?.();
				}
			};
		}));
	}

	/** the names of every wanted tile that is drawn */
	labels(): TileLabel[] {
		const out: TileLabel[] = [];
		for (const k of this.wanted) {
			const t = this.tiles.get(k);
			if (t?.state === 'ready' && t.labels) out.push(...t.labels);
		}
		return out;
	}

	private compose() {
		const show = new Set<THREE_NS.Object3D>();
		for (const k of this.wanted) {
			const t = this.tiles.get(k);
			if (t?.state === 'ready' && t.group) show.add(t.group);
		}
		for (const c of [...this.group.children]) if (!show.has(c)) this.group.remove(c);
		for (const g of show) if (g.parent !== this.group) this.group.add(g);
	}

	private evict() {
		if (this.tiles.size <= 160) return;
		// a vector tile read and waiting for its ground has nothing in flight either
		const old = [...this.tiles.values()].filter((t) => (t.state !== 'loading' || t.flat) && t.used < this.tick)
			.sort((a, b) => a.used - b.used);
		for (const t of old.slice(0, this.tiles.size - 120)) {
			disposeGroup(t.group);
			this.tiles.delete(t.key);
			this.requests.forget(this.requestScope, t.key);
		}
	}

	dispose() {
		this.disposed = true;
		this.requests.release(this.requestScope);
		if (this.ownsRequests) this.requests.dispose();
		for (const t of this.tiles.values()) disposeGroup(t.group);
		this.tiles.clear();
		this.group.removeFromParent();
	}
}

function disposeGroup(g?: THREE_NS.Group) {
	g?.traverse((o) => {
		const m = o as THREE_NS.Mesh;
		m.geometry?.dispose();
		(m.material as THREE_NS.Material | undefined)?.dispose?.();
	});
}
