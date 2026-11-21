import { afterEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { Frame } from './geodesy';
import { AtlasCameras, CAMERA_DEPTH_M, conesOf } from './atlasCameras';
import { solveTint } from './cameraFrusta';
import { WorldRequests } from './worldRequests';

// a level camera looking north: camera x (right) is east, y (down) is -up, z (forward) is north
const LEVEL_NORTH = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
const frame = (idx: number, solve: number, pos: number[], extra: object = {}) =>
	({ idx, solve, pos, rot: LEVEL_NORTH, focal_px: 400, solver_size: 512, photo: `p${idx}`, ...extra });

afterEach(() => vi.unstubAllGlobals());

describe("an atlas's cameras.json", () => {
	test('a cone per camera, sized by its image and focal, in its solve\'s colour', () => {
		const cones = conesOf({ frames: [frame(0, 0, [1, 2, 3]), frame(1, 5, [4, 5, 6], { solver_size: [640, 480] })] });
		expect(cones.map((c) => [c.hw, c.hh, c.tint])).toEqual([[0.64, 0.64, solveTint(0)], [0.8, 0.6, solveTint(5)]]);
		expect(cones[1].pos).toEqual([4, 5, 6]);
	});

	test('a camera without an orientation has no cone; an unreadable one refuses the file', () => {
		expect(conesOf({ frames: [frame(0, 0, [0, 0, 0], { rot: null }), frame(1, 0, [0, 0, 0])] })).toHaveLength(1);
		expect(() => conesOf({ frames: [frame(0, 0, [0, 0])] })).toThrow('camera 0');
		expect(() => conesOf({ frames: [frame(0, -1, [0, 0, 0])] })).toThrow('camera 0');
		expect(() => conesOf({ frames: [frame(0, 0, [0, 0, 0], { solver_size: null })] })).toThrow('image size');
		expect(() => conesOf({ cameras: [] })).toThrow('no frames');
	});
});

describe('AtlasCameras in the scene', () => {
	test("a town's camera stands where its geodetic position does in the scene, before and after a re-layout", async () => {
		const town = new Frame(50.187, 14.66, 230), cam = [120, -45, 4];
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ frames: [frame(0, 2, cam)] }),
			{ status: 200, headers: { 'Content-Type': 'application/json' } })));
		const changed = vi.fn();
		const scene = new THREE.Scene();
		const layer = new AtlasCameras(THREE, { towns: [{ label: 'Brandýs', camerasUrl: 'https://atlas.example/w/full/k/cameras.json',
			frame: town }], scene: new Frame(50.2, 14.7, 0), requests: new WorldRequests(), onChange: changed });
		scene.add(layer.object);
		await vi.waitFor(() => expect(layer.stats.cameras).toBe(1));
		expect(layer.settled).toBe(true);
		const [lat, lon, h] = town.toGeodetic(cam[0], cam[1], cam[2]);
		for (const next of [new Frame(50.2, 14.7, 0), new Frame(50.0, 14.4, 100)]) {
			layer.setScene(next);
			scene.updateMatrixWorld(true);
			const lines = layer.object.children[0] as THREE.LineSegments;
			// vertex 0 is the apex: the camera's centre, offset 0 at any depth
			const p = lines.geometry.getAttribute('position');
			const apex = new THREE.Vector3(p.getX(0), p.getY(0), p.getZ(0)).applyMatrix4(lines.matrixWorld);
			const want = next.fromGeodetic(lat, lon, h);
			expect(apex.distanceTo(new THREE.Vector3(...want))).toBeLessThan(1e-3);
		}
		expect(changed).toHaveBeenCalled();
		expect(CAMERA_DEPTH_M).toBeGreaterThan(0);
		layer.dispose();
		expect(layer.object.parent).toBeNull();
	});

	test("a town whose cameras cannot be read is said, and the scene still settles", async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{"frames": 3}', { status: 200 })));
		const layer = new AtlasCameras(THREE, { towns: [{ label: 'Sadská', camerasUrl: 'https://atlas.example/x/cameras.json',
			frame: new Frame(50.1, 14.9, 200) }], scene: new Frame(50.1, 14.9, 0), requests: new WorldRequests(), onChange: () => {} });
		await vi.waitFor(() => expect(layer.stats.errors.join()).toContain('Sadská: cameras'));
		expect(layer.stats.cameras).toBe(0);
		layer.dispose();
	});
});
