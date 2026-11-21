import { describe, expect, test } from 'vitest';
import { DEFAULT_BUILDING_M, LEVEL_M, clipToTile, decodeMvt, mvtBuildings, mvtLines, mvtOsm } from './mvt';
import { groundedTile, type OsmKinds } from './footprintTiles';
import { credits } from './earth';

// A tile written here, field by field, as the specification lays it out (no OpenStreetMap data is committed)
const varint = (n: number): number[] => {
	const out: number[] = [];
	do {
		let b = n % 128;
		n = Math.floor(n / 128);
		if (n > 0) b |= 0x80;
		out.push(b);
	} while (n > 0);
	return out;
};
const zz = (n: number) => (n >= 0 ? 2 * n : -2 * n - 1);
const field = (num: number, wire: number, payload: number[]) =>
	wire === 2 ? [...varint(num * 8 + 2), ...varint(payload.length), ...payload] : [...varint(num * 8 + wire), ...payload];
const str = (s: string) => [...new TextEncoder().encode(s)];
const packed = (xs: number[]) => xs.flatMap(varint);

/** rings in tile units, each written open: MoveTo, LineTo the rest, ClosePath (not for a line) */
function geometry(rings: [number, number][][], line = false): number[] {
	const out: number[] = [];
	let cx = 0, cy = 0;
	for (const ring of rings) {
		const [x0, y0] = ring[0];
		out.push(1 | (1 << 3), zz(x0 - cx), zz(y0 - cy));
		cx = x0; cy = y0;
		out.push(2 | ((ring.length - 1) << 3));
		for (const [x, y] of ring.slice(1)) { out.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; }
		if (!line) out.push(7 | (1 << 3));
	}
	return out;
}

type F = { tags: Record<string, string | number>; rings: [number, number][][]; line?: true };
/** one layer, as a tile message holds it */
function layerOf(features: F[], name: string): number[] {
	const keys: string[] = [], values: (string | number)[] = [];
	const at = <T>(list: T[], v: T) => (list.indexOf(v) >= 0 ? list.indexOf(v) : list.push(v) - 1);
	const feats = features.map((f) => {
		const tags = Object.entries(f.tags).flatMap(([k, v]) => [at(keys, k), at(values, v)]);
		return field(2, 2, [...field(2, 2, packed(tags)), ...field(3, 0, varint(f.line ? 2 : 3)),
			...field(4, 2, packed(geometry(f.rings, f.line)))]);
	});
	const value = (v: string | number) => (typeof v === 'string' ? field(1, 2, str(v)) : field(5, 0, varint(v)));
	const layer = [...field(15, 0, varint(2)), ...field(1, 2, str(name)), ...feats.flat(),
		...keys.flatMap((k) => field(3, 2, str(k))), ...values.flatMap((v) => field(4, 2, value(v))), ...field(5, 0, varint(4096))];
	return field(3, 2, layer);
}
function tile(features: F[], name = 'building'): Uint8Array {
	return new Uint8Array(layerOf(features, name));
}
/** a tile of several layers, by name */
function tileOf(layers: Record<string, F[]>): Uint8Array {
	return new Uint8Array(Object.entries(layers).flatMap(([name, features]) => layerOf(features, name)));
}

// a square in tile units, its corners in the order the specification calls exterior (positive surveyor's area)
const square = (x: number, y: number, s: number): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const reversed = (r: [number, number][]) => [...r].reverse();

describe('vector tiles (mvt)', () => {
	test('a layer, its tags and its rings, closed', () => {
		const [layer] = decodeMvt(tile([{ tags: { osm_id: 31066538, building: 'church' }, rings: [square(100, 100, 100)] }]));
		expect(layer.name).toBe('building');
		expect(layer.extent).toBe(4096);
		expect(layer.features[0].tags).toEqual({ osm_id: 31066538, building: 'church' });
		expect(layer.features[0].geometry).toEqual([[[100, 100], [200, 100], [200, 200], [100, 200], [100, 100]]]);
	});

	test('a building is its outline and its courtyard; heights from height, then levels, else one storey', () => {
		const t = tile([
			{ tags: { osm_id: 1, height: '12 m' }, rings: [square(100, 100, 400), reversed(square(200, 200, 100))] },
			{ tags: { osm_id: 2, 'building:levels': '3' }, rings: [square(1000, 1000, 50)] },
			{ tags: { osm_id: 3 }, rings: [square(2000, 2000, 50)] }
		]);
		const out = mvtBuildings(decodeMvt(t), 15, 17718, 11086);
		expect(out.map((b) => [b.id, b.ring.length, b.holes.map((h) => h.length), b.height_source, b.height_m])).toEqual([
			[1, 5, [5], 'height', 12], [2, 5, [], 'levels', 3 * LEVEL_M], [3, 5, [], 'default', DEFAULT_BUILDING_M]]);
		expect(DEFAULT_BUILDING_M).toBe(3);
		// tile units to degrees: the tile's own corner is its north-west
		expect(out[0].ring[0][1]).toBeCloseTo((17718 + 100 / 4096) / 2 ** 15 * 360 - 180, 9);
		expect(out[0].ring[0][0]).toBeGreaterThan(out[0].ring[2][0]);
	});

	test('a building in two tiles (one in its buffer) is kept by the tile holding its centroid, once', () => {
		// whole in both, offset by the extent: its centroid is at 4100 in the west tile, 4 in the east one
		const west = tile([{ tags: { osm_id: 7 }, rings: [square(4000, 1000, 200)] }]);
		const east = tile([{ tags: { osm_id: 7 }, rings: [square(-96, 1000, 200)] }]);
		expect(mvtBuildings(decodeMvt(west), 15, 100, 200)).toEqual([]);
		const kept = mvtBuildings(decodeMvt(east), 15, 101, 200);
		expect(kept.map((b) => b.id)).toEqual([7]);
	});

	test("a courtyard goes with its building: one whose outline is another tile's takes its courtyard along", () => {
		const t = tile([{ tags: { osm_id: 9 }, rings: [square(4000, 100, 400), reversed(square(4100, 200, 100)),
			square(1000, 1000, 300), reversed(square(1100, 1100, 100))] }]);
		const out = mvtBuildings(decodeMvt(t), 15, 0, 0);
		// the first outline's centroid lies east of the tile: it and its courtyard are the neighbour's
		expect(out.map((b) => [b.ring.length, b.holes.length])).toEqual([[5, 1]]);
		expect(out[0].holes[0][0][1]).toBeCloseTo((1100 / 4096) / 2 ** 15 * 360 - 180, 9);
	});

	test('a line is cut at the tile edge, so two tiles holding it in their buffers draw each metre once', () => {
		// a road across the edge between two tiles, whole in each one's buffer
		expect(clipToTile([[4000, 100], [4200, 100]], 4096)).toEqual([[[4000, 100], [4096, 100]]]);
		expect(clipToTile([[-96, 100], [104, 100]], 4096)).toEqual([[[0, 100], [104, 100]]]);
		// out and back in: two pieces; wholly outside: none
		expect(clipToTile([[100, 100], [100, -50], [200, -50], [200, 100]], 4096)).toEqual([[[100, 100], [100, 0]], [[200, 0], [200, 100]]]);
		expect(clipToTile([[-500, -500], [-100, -100]], 4096)).toEqual([]);
		// along a shared edge: the left tile's right edge is the right tile's left edge, drawn by the right tile only
		expect(clipToTile([[4096, 100], [4096, 200]], 4096)).toEqual([]);
		expect(clipToTile([[0, 100], [0, 200]], 4096)).toEqual([[[0, 100], [0, 200]]]);
	});

	test("roads are the road layer's lines; water its waterways and every shore, a lake's ring closed", () => {
		const t = tileOf({
			building: [{ tags: { osm_id: 1 }, rings: [square(100, 100, 100)] }],
			road: [{ tags: { highway: 'residential' }, rings: [[[0, 2000], [4096, 2000]]], line: true }],
			water: [{ tags: { natural: 'water' }, rings: [square(3000, 3000, 200)] },
				{ tags: { waterway: 'stream' }, rings: [[[500, 0], [500, 4096]]], line: true }]
		});
		const osm = mvtOsm(decodeMvt(t), 15, 17718, 11086);
		expect([osm.buildings.length, osm.roads.length, osm.water.length]).toEqual([1, 1, 2]);
		expect(osm.roads[0]).toHaveLength(2);
		const shore = osm.water[0];
		expect(shore).toHaveLength(5);
		expect(shore[4]).toEqual(shore[0]);
		expect(mvtLines(decodeMvt(t), 'rail', 15, 17718, 11086)).toEqual([]);
	});

	test('a tile with no building layer has no footprints; a broken one says so', () => {
		expect(mvtBuildings(decodeMvt(tile([{ tags: { osm_id: 5 }, rings: [square(0, 0, 10)] }], 'road')), 15, 0, 0)).toEqual([]);
		expect(() => decodeMvt(new Uint8Array([0x1a, 0x05, 0x0a]))).toThrow('mvt');
	});
});

describe('a vector tile stood on the ground', () => {
	// a z15 tile is ~783 m across at this latitude: the road is ~196 m long (1024 tile units)
	const osm = mvtOsm(decodeMvt(tileOf({
		building: [{ tags: { osm_id: 1, 'building:levels': '2' }, rings: [square(1000, 1000, 100), reversed(square(1030, 1030, 40))] },
			{ tags: { osm_id: 2 }, rings: [square(3000, 3000, 100)] }],
		road: [{ tags: { highway: 'residential' }, rings: [[[1000, 2000], [2024, 2000]]], line: true }],
		water: [{ tags: { natural: 'water' }, rings: [square(3000, 500, 200)] }]
	})), 15, 17718, 11086);
	const ground = () => ({ h: 230.5, z: 15 });
	const all: OsmKinds = { buildings: true, roads: true, water: true };

	test('each building vertex, courtyards too, at the terrain under it; the zoom that answered at the centre kept', () => {
		const g = groundedTile(15, 17718, 11086, osm, ground, all)!;
		expect(g.groundZ).toBe(15);
		expect(g.tile.buildings.map((b) => b.id)).toEqual([1, 2]);
		expect(g.tile.buildings[0].ring.every((v) => v[2] === 230.5)).toBe(true);
		expect(g.tile.buildings[0].holes!.map((h) => h.every((v) => v[2] === 230.5))).toEqual([true]);
		expect(g.tile.buildings[0].height_m).toBe(2 * LEVEL_M);
	});

	test('a road and a shore follow the terrain: a vertex at least every 8 m, each on the ground under it', () => {
		const sloped = (lat: number, lon: number) => ({ h: 200 + (lon - 14.6) * 10_000, z: 15 });
		const g = groundedTile(15, 17718, 11086, osm, sloped, all)!;
		const road = g.tile.roads[0].line;
		expect(road.length).toBeGreaterThanOrEqual(25);
		for (const v of road) expect(v[2]).toBeCloseTo(200 + (v[1] - 14.6) * 10_000, 6);
		const step = (a: number[], b: number[]) => Math.hypot((b[0] - a[0]) * 111_320, (b[1] - a[1]) * 111_320 * Math.cos(a[0] * Math.PI / 180));
		for (let i = 1; i < road.length; i++) expect(step(road[i - 1], road[i])).toBeLessThanOrEqual(8.0001);
		expect(g.tile.water[0].line[0]).toEqual(g.tile.water[0].line.at(-1));
	});

	test('each layer only when chosen', () => {
		const only = (k: Partial<OsmKinds>) => {
			const t = groundedTile(15, 17718, 11086, osm, ground, { buildings: false, roads: false, water: false, ...k })!.tile;
			return [t.buildings.length, t.roads.length, t.water.length];
		};
		expect([only({ buildings: true }), only({ roads: true }), only({ water: true })]).toEqual([[2, 0, 0], [0, 1, 0], [0, 0, 1]]);
	});

	test('a tile waits while the terrain cannot answer, at its centre or under any vertex of what it draws', () => {
		expect(groundedTile(15, 17718, 11086, osm, () => null, all)).toBeNull();
		let n = 0;
		expect(groundedTile(15, 17718, 11086, osm, () => (++n > 3 ? null : { h: 1, z: 12 }), all)).toBeNull();
		// the road's far end has no ground yet: no roads, no wait
		const west = (lat: number, lon: number) => (lon < osm.roads[0][1][1] - 1e-9 ? { h: 1, z: 12 } : null);
		expect(groundedTile(15, 17718, 11086, osm, west, all)).toBeNull();
	});
});

test('the credit line names OpenStreetMap once, for its names, its tiles or both', () => {
	const src = (key: string) => ({ text: key, url: `https://${key}.example`, licence: 'x' });
	const sources = Object.fromEntries(['cuzk', 'glo30', 'etopo', 'osm'].map((k) => [k, src(k)]));
	const osm = (shown: { names?: boolean; osm?: boolean }) =>
		credits(sources, { orthoYear: null, ...shown }).filter((c) => c.text === 'osm').length;
	expect([osm({}), osm({ names: true }), osm({ osm: true }), osm({ names: true, osm: true })]).toEqual([0, 1, 1, 1]);
});
