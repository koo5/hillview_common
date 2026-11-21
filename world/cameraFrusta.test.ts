import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { CONE_VERTICES, CameraFrusta, oklab, solveTint, type Cone, type Rot, type Vec3 } from './cameraFrusta';

// a camera turned about two axes, so a mixed-up row or column would show
function rotation(yaw: number, pitch: number): Rot {
	const m = new THREE.Matrix4().makeRotationZ(yaw).multiply(new THREE.Matrix4().makeRotationX(pitch));
	const e = m.elements;     // column-major
	return [[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]];
}

const cones: Cone[] = [
	{ pos: [10, -4, 2.5], rot: rotation(0.4, 1.2), hw: 0.6, hh: 0.45, tint: 0x3987e5 },
	{ pos: [-30, 12, 1.7], rot: rotation(-2.1, 1.5), hw: 0.7, hh: 0.93, tint: 0xe0a23a }
];

/** where the per-camera way puts a cone's vertices: a Group at the camera's pose, scaled by the depth, holding the
 *  cone at unit depth (the workbench viewer's loadCameras + coneLines) */
function perCamera(c: Cone, depth: number): Vec3[] {
	const m = new THREE.Matrix4().set(c.rot[0][0], c.rot[0][1], c.rot[0][2], c.pos[0], c.rot[1][0], c.rot[1][1], c.rot[1][2], c.pos[1],
		c.rot[2][0], c.rot[2][1], c.rot[2][2], c.pos[2], 0, 0, 0, 1);
	const cam = new THREE.Group();
	cam.applyMatrix4(m);
	cam.scale.setScalar(depth);
	cam.updateMatrixWorld(true);
	const corners = [[-c.hw, -c.hh], [c.hw, -c.hh], [c.hw, c.hh], [-c.hw, c.hh]];
	const local: number[][] = [];
	for (let i = 0; i < 4; i++) {
		const [x, y] = corners[i], [nx, ny] = corners[(i + 1) % 4];
		local.push([0, 0, 0], [x, y, 1], [x, y, 1], [nx, ny, 1]);
	}
	return local.map(([x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(cam.matrixWorld).toArray() as Vec3);
}

const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// CameraFrusta's attributes are plain BufferAttributes (its own); the version counts their uploads
const version = (f: CameraFrusta) => (f.lines.geometry.getAttribute('position') as THREE.BufferAttribute).version;

describe('camera frusta in one draw', () => {
	test('every cone in one LineSegments, 16 vertices each', () => {
		const f = new CameraFrusta(THREE, cones, 3);
		expect(f.lines).toBeInstanceOf(THREE.LineSegments);
		expect(f.lines.geometry.getAttribute('position').count).toBe(cones.length * CONE_VERTICES);
		expect(f.count).toBe(2);
		f.dispose();
	});

	test('each vertex stands where the per-camera group puts it, at any depth, without a rebuild', () => {
		const f = new CameraFrusta(THREE, cones, 3);
		const arrays = ['position', 'offset'].map((a) => f.lines.geometry.getAttribute(a).array);
		for (const depth of [3, 0.5, 12]) {
			f.setDepth(depth);
			cones.forEach((c, i) => perCamera(c, depth).forEach((want, v) => expect(near(f.vertex(i, v), want)).toBeLessThan(1e-4)));
		}
		expect(['position', 'offset'].map((a) => f.lines.geometry.getAttribute(a).array)).toEqual(arrays);
		f.dispose();
	});

	test('a moved camera rewrites its own vertices, and only those', () => {
		const f = new CameraFrusta(THREE, cones, 2);
		const other = Array.from({ length: CONE_VERTICES }, (_, v) => f.vertex(1, v));
		const before = version(f);
		const moved: Cone = { ...cones[0], pos: [11, -3, 2], rot: rotation(1.0, 0.9) };
		f.setPose(0, moved.pos, moved.rot);
		perCamera(moved, 2).forEach((want, v) => expect(near(f.vertex(0, v), want)).toBeLessThan(1e-4));
		expect(Array.from({ length: CONE_VERTICES }, (_, v) => f.vertex(1, v))).toEqual(other);
		expect(version(f)).toBeGreaterThan(before);
		expect(() => f.setPose(2, moved.pos, moved.rot)).toThrow('no cone 2');
		f.dispose();
	});

	test('the apex near white, the top edge in the tint, the bottom edge green', () => {
		const f = new CameraFrusta(THREE, [cones[0]], 1);
		const c = f.lines.geometry.getAttribute('color');
		const rgb = (v: number) => [c.getX(v), c.getY(v), c.getZ(v)];
		const t = [0x39 / 255, 0x87 / 255, 0xe5 / 255];
		// vertex 0 is the apex; 1 the top-left corner (camera y = -hh: the photograph's top); 9 the bottom-right
		rgb(0).forEach((x, i) => expect(x).toBeCloseTo(t[i] + (1 - t[i]) * 0.7, 5));
		rgb(1).forEach((x, i) => expect(x).toBeCloseTo(t[i], 5));
		expect(rgb(9)[1]).toBeGreaterThan(rgb(9)[0]);
		expect(rgb(9)[1]).toBeGreaterThan(rgb(9)[2]);
		f.dispose();
	});
});

describe('a tint per solve', () => {
	const hue = (rgb: number) => {
		const c = new THREE.Color().setHex(rgb, THREE.SRGBColorSpace);
		const hsl = { h: 0, s: 0, l: 0 };
		c.getHSL(hsl, THREE.SRGBColorSpace);
		return hsl.h * 360;
	};

	test('a town of 44 solves gets 44 colours, none amber, yellow or bottom-edge green, the same every time', () => {
		const tints = Array.from({ length: 44 }, (_, i) => solveTint(i));
		expect(new Set(tints).size).toBe(44);
		// never inside the left-out bands, amber to yellow [25, 70) and green [95, 160) (half a degree for rounding to RGB)
		for (const t of tints) {
			const h = hue(t);
			expect(h > 25.5 && h < 69.5, `hue ${h}`).toBe(false);
			expect(h > 95.5 && h < 159.5, `hue ${h}`).toBe(false);
		}
		expect(Array.from({ length: 44 }, (_, i) => solveTint(i))).toEqual(tints);
		expect(solveTint(0)).toBe(hslHex(210, 0.8, 0.58));          // the blue a run's own cameras have
	});

	test('no two of a town\'s solves look alike: every pair of 44 apart in OKLab, solves 0 and 34 among them', () => {
		const labs = Array.from({ length: 44 }, (_, i) => oklab(solveTint(i)));
		let min = Infinity, at = [0, 0];
		for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) {
			const d = Math.hypot(labs[i][0] - labs[j][0], labs[i][1] - labs[j][1], labs[i][2] - labs[j][2]);
			if (d < min) { min = d; at = [i, j]; }
		}
		// golden-angle hues alone put solves 0 and 34 3.4 degrees apart: 0.011 here
		expect(min, `solves ${at}`).toBeGreaterThan(0.05);
	});

	test('a solve keeps its colour however many solves follow it, and an index that is none is refused', () => {
		const first = solveTint(5);
		solveTint(120);
		expect(solveTint(5)).toBe(first);
		expect(() => solveTint(-1)).toThrow('not a solve index');
		expect(() => solveTint(1.5)).toThrow('not a solve index');
	});
});

/** 0xrrggbb of an HSL colour, as the palette makes its candidates */
function hslHex(h: number, s: number, l: number): number {
	const c = new THREE.Color().setHSL(h / 360, s, l, THREE.SRGBColorSpace);
	return c.getHex(THREE.SRGBColorSpace);
}
