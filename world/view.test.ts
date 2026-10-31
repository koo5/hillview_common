import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ViewGate, cameraView } from './view';
import type { View } from './terrainTiles';

const wide: View = { dir: [0, 1, 0], fovY: 55, aspect: 1.6, heightPx: 800 };

describe('ViewGate', () => {
	it('asks again only for a changed view, at most once per interval', () => {
		const g = new ViewGate(330);
		expect(g.due([0, 0, 10], wide, 0)).toBe(true);
		expect(g.due([0, 0, 10], wide, 1000)).toBe(false); // nothing changed
		expect(g.due([5, 0, 10], wide, 100)).toBe(false); // changed, too soon
		expect(g.due([5, 0, 10], wide, 400)).toBe(true);
		// turning or zooming in place is a change too
		expect(g.due([5, 0, 10], { ...wide, fovY: 5 }, 800)).toBe(true);
		expect(g.due([5, 0, 10], { ...wide, fovY: 5, dir: [1, 0, 0] }, 1200)).toBe(true);
	});

	it('tells a changed view inside the interval (soon) from an unchanged one (same)', () => {
		const g = new ViewGate(330);
		expect(g.state([0, 0, 0], wide, 0)).toBe('due');
		expect(g.state([0, 0, 0], wide, 10)).toBe('same');
		expect(g.state([1, 0, 0], wide, 10)).toBe('soon');
		expect(g.state([1, 0, 0], wide, 400)).toBe('due');
		expect(g.interval).toBe(330);
	});

	it('goes through when forced, or once after a reset', () => {
		const g = new ViewGate();
		g.due([0, 0, 0], wide, 0);
		expect(g.due([0, 0, 0], wide, 1, true)).toBe(true);
		g.reset();
		expect(g.due([0, 0, 0], wide, 2000)).toBe(true);
		expect(g.due([0, 0, 0], wide, 4000)).toBe(false);
	});
});

describe('cameraView', () => {
	it('is the drawn field of view: a zoom narrows it as fov does', () => {
		const cam = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
		cam.lookAt(0, 0, -1);
		const v = cameraView(cam, new THREE.Vector3(), 500);
		expect(v.fovY).toBeCloseTo(60);
		expect(v.aspect).toBe(2);
		expect(v.heightPx).toBe(500);
		expect(v.dir[2]).toBeCloseTo(-1);
		cam.zoom = 2;
		expect(cameraView(cam, new THREE.Vector3(), 500).fovY).toBeCloseTo((2 * Math.atan(Math.tan(Math.PI / 6) / 2) * 180) / Math.PI);
	});
});
