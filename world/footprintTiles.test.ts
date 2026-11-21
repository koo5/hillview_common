import { afterEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { Frame } from './geodesy';
import { FootprintTiles, buildMapTile, groundedTile, type GroundAt, type OsmKinds } from './footprintTiles';
import { WorldRequests } from './worldRequests';
import type { OsmTile } from './mvt';

// one small building with a courtyard near Brandýs' square, and a road past it, as a vector tile reads (mvt.test.ts
// reads tile bytes)
const lat = 50.1871, lon = 14.6617, d = 0.0001, q = d / 4;
const flat: OsmTile = {
	buildings: [{ id: 1, height_m: 9, height_source: 'levels',
		ring: [[lat, lon], [lat, lon + d], [lat - d, lon + d], [lat - d, lon], [lat, lon]],
		holes: [[[lat - q, lon + q], [lat - 3 * q, lon + q], [lat - 3 * q, lon + 3 * q], [lat - q, lon + 3 * q], [lat - q, lon + q]]] }],
	roads: [[[lat + d, lon], [lat + d, lon + 5 * d]]],
	walls: [[[lat - 2 * d, lon], [lat - 2 * d, lon + 3 * d]]],
	water: []
};
const ground: GroundAt = () => ({ h: 230, z: 15 });
const ALL: OsmKinds = { buildings: true, roads: true, walls: true, water: true };

type Inner = { wanted: string[]; tiles: Map<string, { key: string; state: string; used: number; flat?: OsmTile;
	group?: THREE.Group }>; ground(): void };

/** footprints with `n` vector tiles read and wanted, none standing yet */
function waiting(n: number, frame = new Frame(lat, lon, 230), onChange = () => {}) {
	const fp = new FootprintTiles(THREE, { format: 'mvt', tileUrl: 'https://earth.example/osm/{z}/{x}/{y}.mvt', frame,
		requests: new WorldRequests(), ground, kinds: ALL, onChange });
	const inner = fp as unknown as Inner;
	inner.wanted = Array.from({ length: n }, (_, i) => `15/${17718 + i}/11086`);
	for (const key of inner.wanted) inner.tiles.set(key, { key, state: 'loading', used: 0, flat });
	return { fp, inner };
}

afterEach(() => vi.restoreAllMocks());

describe('FootprintTiles over vector tiles', () => {
	test('vector tiles carry no heights and name no layers: without a ground or the layers, it refuses to start', () => {
		expect(() => new FootprintTiles(THREE, { format: 'mvt', tileUrl: 'x', frame: new Frame(lat, lon, 0), kinds: ALL })).toThrow('ground');
		expect(() => new FootprintTiles(THREE, { format: 'mvt', tileUrl: 'x', frame: new Frame(lat, lon, 0), ground })).toThrow('kinds');
	});

	test('a layer toggled: every tile built again from what was read, without it, and not ready until it is', () => {
		vi.spyOn(performance, 'now').mockReturnValue(0);   // the clock stands still: the frame budget is not what is tested
		const { fp, inner } = waiting(2);
		const lines = () => inner.tiles.get(inner.wanted[0])!.group!.children.filter((c) => c instanceof THREE.LineSegments).length;
		inner.ground();
		expect(fp.stats).toMatchObject({ ready: 2, loading: 0 });
		const withRoads = lines();
		fp.setKinds({ ...ALL });                      // the same choice: nothing to do
		expect(fp.stats).toMatchObject({ ready: 2, loading: 0 });
		fp.setKinds({ ...ALL, roads: false });
		expect(fp.stats).toMatchObject({ ready: 0, loading: 2 });
		expect(fp.settled).toBe(false);
		inner.ground();
		expect(fp.stats).toMatchObject({ ready: 2, loading: 0 });
		expect(lines()).toBe(withRoads - 1);
		fp.setKinds({ ...ALL, roads: false, walls: false });
		inner.ground();
		expect(lines()).toBe(withRoads - 2);
		fp.dispose();
	});

	test("a building's courtyard has its own walls, up to the building's roof", () => {
		const g = groundedTile(15, 17718, 11086, flat, ground, { ...ALL, roads: false })!;
		const walls = (t: typeof g.tile) => {
			const mesh = buildMapTile(THREE, new Frame(lat, lon, 230), t).children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
			return mesh.geometry.getAttribute('position').count / 6;
		};
		expect(walls(g.tile)).toBe(8);
		expect(walls({ ...g.tile, buildings: g.tile.buildings.map((b) => ({ ...b, holes: [] })) })).toBe(4);
	});

	test('tiles stand a frame budget at a time, nearest first, and ask for another frame while more wait', () => {
		let clock = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 3));   // each look at the clock: 3 ms on
		const onChange = vi.fn();
		const { fp, inner } = waiting(7, undefined, onChange);
		const standing = () => inner.wanted.map((k) => inner.tiles.get(k)!.state === 'ready');
		inner.ground();
		expect(standing()).toEqual([true, true, true, false, false, false, false]);
		expect(onChange).toHaveBeenCalledTimes(1);
		inner.ground();
		inner.ground();
		expect(fp.stats.ready).toBe(7);
		expect(onChange).toHaveBeenCalledTimes(2);    // the last frame had nothing left to ask for
		fp.dispose();
	});

	test('a re-layout carries the standing tiles where tiles built in the new frame stand, nothing rebuilt', () => {
		const a = new Frame(50.0875, 14.4214, 0), b = new Frame(lat, lon, 230);
		const { fp, inner } = waiting(1, a);
		inner.ground();
		const tile = inner.tiles.get(inner.wanted[0])!, built = tile.group!;
		fp.setFrame(b);
		expect(tile.group).toBe(built);
		const want = buildMapTile(THREE, b, groundedTile(15, 17718, 11086, flat, ground, ALL)!.tile);
		built.updateMatrixWorld(true); want.updateMatrixWorld(true);
		const first = (g: THREE.Group) => {
			const line = g.children.find((c) => c instanceof THREE.LineSegments) as THREE.LineSegments;
			const p = line.geometry.getAttribute('position');
			return new THREE.Vector3(p.getX(0), p.getY(0), p.getZ(0)).applyMatrix4(line.matrixWorld);
		};
		expect(first(built).distanceTo(first(want))).toBeLessThan(0.01);
		fp.dispose();
	});
});
