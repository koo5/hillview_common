import { describe, expect, it } from 'vitest';
import { headingOf, headingTicks, localAxes, windOf } from './compass';
import { Frame } from './geodesy';

describe('heading', () => {
	it('true north at the camera: 20 km east of the origin the world frame is turned by the meridian convergence', () => {
		const world = new Frame(50, 14, 300);
		// at the origin, the world frame IS the local frame
		const here = localAxes(world, [0, 0, 0]);
		expect(headingOf([0, 1, 0], here).bearing).toBeCloseTo(0, 6);
		expect(headingOf([1, 0, 0], here).bearing).toBeCloseTo(90, 6);
		// 20 km east: the world's +y points east of true north by ~dlon sin(lat)
		const east = localAxes(world, world.fromGeodetic(50, 14 + 20_000 / 71_700, 300));
		const conv = (20_000 / 71_700) * Math.sin((50 * Math.PI) / 180);
		expect(headingOf([0, 1, 0], east).bearing).toBeCloseTo(conv, 2);
		// and without a frame (a run's own ENU) +y is north
		expect(headingOf([0, 1, 0], localAxes(null, [5000, 0, 0])).bearing).toBe(0);
	});

	it('pitch is the angle above the local horizontal', () => {
		const ax = localAxes(null, [0, 0, 0]);
		expect(headingOf([0, 1, 1], ax).pitch).toBeCloseTo(45, 9);
		expect(headingOf([0, 1, -0.01], ax).pitch).toBeCloseTo(-0.573, 3);
	});

	it('names the sixteen winds', () => {
		expect(windOf(197.7)).toBe('SSW');
		expect(windOf(359)).toBe('N');
		expect(windOf(90)).toBe('E');
		expect(windOf(-10)).toBe('N');
	});
});

describe('the tape', () => {
	it('across north: N where the bearing is 0, every tick once, labels far enough apart to read', () => {
		// 600 px from 350 to 20 degrees: 20 px a degree
		const xs: number[] = [], bs: number[] = [];
		for (let x = 0; x <= 600; x += 6) { xs.push(x); bs.push((350 + x / 20) % 360); }
		const t = headingTicks(xs, bs);
		const n = t.find((k) => k.label === 'N')!;
		expect(n.x).toBeCloseTo(200, 6);
		expect(new Set(t.map((k) => k.deg)).size).toBe(t.length);
		const labelled = t.filter((k) => k.label).map((k) => k.x).sort((a, b) => a - b);
		for (let i = 1; i < labelled.length; i++) expect(labelled[i] - labelled[i - 1]).toBeGreaterThanOrEqual(56);
		expect(t.filter((k) => k.label).map((k) => k.label)).toEqual(['350', '355', 'N', '5', '10', '15', '20']);
	});

	it('through a telephoto: tenths of a degree', () => {
		// 1600 px across 0.5 degrees at 197.5..198
		const xs: number[] = [], bs: number[] = [];
		for (let x = 0; x <= 1600; x += 8) { xs.push(x); bs.push(197.5 + (0.5 * x) / 1600); }
		const t = headingTicks(xs, bs);
		expect(t.some((k) => k.label === '197.7')).toBe(true);
		expect(t.every((k) => k.deg >= 197.5 && k.deg <= 198)).toBe(true);
	});
});
