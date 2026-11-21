import { describe, expect, test } from 'vitest';
import { decodeMvt, mvtBuildings, LEVEL_M } from './mvt';
import { groundedTile, type PlanCircle } from './footprintTiles';
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

/** rings in tile units, each written open: MoveTo, LineTo the rest, ClosePath */
function geometry(rings: [number, number][][]): number[] {
	const out: number[] = [];
	let cx = 0, cy = 0;
	for (const ring of rings) {
		const [x0, y0] = ring[0];
		out.push(1 | (1 << 3), zz(x0 - cx), zz(y0 - cy));
		cx = x0; cy = y0;
		out.push(2 | ((ring.length - 1) << 3));
		for (const [x, y] of ring.slice(1)) { out.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; }
		out.push(7 | (1 << 3));
	}
	return out;
}

type F = { tags: Record<string, string | number>; rings: [number, number][][] };
function tile(features: F[], name = 'building'): Uint8Array {
	const keys: string[] = [], values: (string | number)[] = [];
	const at = <T>(list: T[], v: T) => (list.indexOf(v) >= 0 ? list.indexOf(v) : list.push(v) - 1);
	const feats = features.map((f) => {
		const tags = Object.entries(f.tags).flatMap(([k, v]) => [at(keys, k), at(values, v)]);
		return field(2, 2, [...field(2, 2, packed(tags)), ...field(3, 0, varint(3)), ...field(4, 2, packed(geometry(f.rings)))]);
	});
	const value = (v: string | number) => (typeof v === 'string' ? field(1, 2, str(v)) : field(5, 0, varint(v)));
	const layer = [...field(15, 0, varint(2)), ...field(1, 2, str(name)), ...feats.flat(),
		...keys.flatMap((k) => field(3, 2, str(k))), ...values.flatMap((v) => field(4, 2, value(v))), ...field(5, 0, varint(4096))];
	return new Uint8Array(field(3, 2, layer));
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

	test('a building is its outline, its hole left out; heights from height, then levels, else a guess', () => {
		const t = tile([
			{ tags: { osm_id: 1, height: '12 m' }, rings: [square(100, 100, 400), reversed(square(200, 200, 100))] },
			{ tags: { osm_id: 2, 'building:levels': '3' }, rings: [square(1000, 1000, 50)] },
			{ tags: { osm_id: 3 }, rings: [square(2000, 2000, 50)] }
		]);
		const out = mvtBuildings(decodeMvt(t), 15, 17718, 11086);
		expect(out.map((b) => [b.id, b.ring.length, b.height_source, b.height_m])).toEqual([
			[1, 5, 'height', 12], [2, 5, 'levels', 3 * LEVEL_M], [3, 5, 'default', undefined]]);
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

	test('a tile with no building layer has no footprints; a broken one says so', () => {
		expect(mvtBuildings(decodeMvt(tile([{ tags: { osm_id: 5 }, rings: [square(0, 0, 10)] }], 'road')), 15, 0, 0)).toEqual([]);
		expect(() => decodeMvt(new Uint8Array([0x1a, 0x05, 0x0a]))).toThrow('mvt');
	});
});

describe('footprints stood on the ground', () => {
	const flat = mvtBuildings(decodeMvt(tile([
		{ tags: { osm_id: 1, 'building:levels': '2' }, rings: [square(1000, 1000, 100)] },
		{ tags: { osm_id: 2 }, rings: [square(3000, 3000, 100)] }
	])), 15, 17718, 11086);
	const ground = () => ({ h: 230.5, z: 15 });

	test('each vertex at the terrain under it; the zoom that answered at the centre kept', () => {
		const g = groundedTile(15, 17718, 11086, flat, ground, [])!;
		expect(g.groundZ).toBe(15);
		expect(g.tile.buildings.map((b) => b.id)).toEqual([1, 2]);
		expect(g.tile.buildings[0].ring.every((v) => v[2] === 230.5)).toBe(true);
		expect(g.tile.buildings[0].height_m).toBe(2 * LEVEL_M);
	});

	test('a tile waits while the terrain cannot answer, at its centre or under any vertex', () => {
		expect(groundedTile(15, 17718, 11086, flat, () => null, [])).toBeNull();
		let n = 0;
		expect(groundedTile(15, 17718, 11086, flat, () => (++n > 3 ? null : { h: 1, z: 12 }), [])).toBeNull();
	});

	test('a building whose centroid stands under a city model is left out, the other drawn', () => {
		const [lat, lon] = flat[0].ring[0];
		const model: PlanCircle = { lat, lon, radius: 60 };
		const far: PlanCircle = { lat: 0, lon: 0, radius: 500 };
		expect(groundedTile(15, 17718, 11086, flat, ground, [model, far])!.tile.buildings.map((b) => b.id)).toEqual([2]);
	});
});

test('the credit line names OpenStreetMap once, for its names, its footprints or both', () => {
	const src = (key: string) => ({ text: key, url: `https://${key}.example`, licence: 'x' });
	const sources = Object.fromEntries(['cuzk', 'glo30', 'etopo', 'osm'].map((k) => [k, src(k)]));
	const osm = (shown: { names?: boolean; footprints?: boolean }) =>
		credits(sources, { orthoYear: null, ...shown }).filter((c) => c.text === 'osm').length;
	expect([osm({}), osm({ names: true }), osm({ footprints: true }), osm({ names: true, footprints: true })]).toEqual([0, 1, 1, 1]);
});
