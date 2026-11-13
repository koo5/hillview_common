import { describe, expect, it } from 'vitest';
import { Frame } from './geodesy';
import { scaledFov } from './flight';
import { groundDrag, touchMetresPerPixel, touchPair, TouchTravel, wheelFov } from './sceneGestures';

describe('scene zoom gestures', () => {
	it('normalizes pixel, line and page wheels, and reverses direction without changing zoom sensitivity', () => {
		const inward = wheelFov(55, -100, 0, 800);
		expect(inward).toBeLessThan(55);
		expect(wheelFov(inward, 100, 0, 800)).toBeCloseTo(55, 10);
		expect(wheelFov(55, -6.25, 1, 800)).toBeCloseTo(inward, 10);
		expect(wheelFov(55, -0.125, 2, 800)).toBeCloseTo(inward, 10);
	});
	it('ignores pinch jitter but preserves a slow drag and resets when fingers change', () => {
		const travel = new TouchTravel();
		for (let i = 0; i < 30; i++) {
			expect(travel.move(0.5, 0.5)).toBeNull();
			expect(travel.move(-0.5, -0.5)).toBeNull();
		}
		for (let i = 0; i < 6; i++) expect(travel.move(0, -0.5)).toBeNull();
		expect(travel.move(0, -0.5)).toEqual({ x: 0, y: -3.5 });
		expect(travel.move(0, -0.5)).toEqual({ x: 0, y: -0.5 });
		travel.reset();
		expect(travel.move(0, -0.5)).toBeNull();
	});

	it('bounds repeated zoom gestures at both ends', () => {
		let narrow = 55, wide = 55;
		for (let i = 0; i < 100; i++) {
			narrow = wheelFov(narrow, -10000, 0, 800);
			wide = wheelFov(wide, 10000, 0, 800);
		}
		expect(narrow).toBe(0.1);
		expect(wide).toBe(120);
	});

	it('separates a symmetric pinch from travel, and a parallel drag from zoom', () => {
		const before = touchPair([{ x: 100, y: 200 }, { x: 200, y: 200 }])!;
		const pinch = touchPair([{ x: 50, y: 200 }, { x: 250, y: 200 }])!;
		expect(pinch.x).toBe(before.x);
		expect(pinch.y).toBe(before.y);
		expect(scaledFov(55, before.distance / pinch.distance)).toBeLessThan(55);
		const drag = touchPair([{ x: 120, y: 150 }, { x: 220, y: 150 }])!;
		expect(drag.distance).toBe(before.distance);
		expect([drag.x - before.x, drag.y - before.y]).toEqual([20, -50]);
		for (const points of [[], [{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]]) {
			expect(touchPair(points)).toBeNull();
		}
	});
});

describe('two-finger ground travel', () => {
	const frame = new Frame(50, 14);
	const position = frame.fromGeodetic(50.2, 14.3, 1250.75);
	it('goes forward/backward and sideways relative to true heading, away from the frame origin', () => {
		for (const bearing of [0, 90, 180, 270]) {
			const [lat, lon, h] = frame.toGeodetic(...groundDrag(frame, position, bearing, 0, -100, 1));
			const [rightLat, rightLon] = frame.toGeodetic(...groundDrag(frame, position, bearing, 100, 0, 1));
			const [backLat, backLon] = frame.toGeodetic(...groundDrag(frame, position, bearing, 0, 100, 1));
			if (bearing === 0) { expect(lat).toBeGreaterThan(50.2); expect(rightLon).toBeGreaterThan(14.3); expect(backLat).toBeLessThan(50.2); }
			if (bearing === 90) { expect(lon).toBeGreaterThan(14.3); expect(rightLat).toBeLessThan(50.2); expect(backLon).toBeLessThan(14.3); }
			if (bearing === 180) { expect(lat).toBeLessThan(50.2); expect(rightLon).toBeLessThan(14.3); expect(backLat).toBeGreaterThan(50.2); }
			if (bearing === 270) { expect(lon).toBeLessThan(14.3); expect(rightLat).toBeGreaterThan(50.2); expect(backLon).toBeGreaterThan(14.3); }
			expect(h).toBeCloseTo(1250.75, 5);
		}
	});
	it('keeps altitude even over a large diagonal move', () => {
		const [lat, lon, h] = frame.toGeodetic(...groundDrag(frame, position, 30, 1000, -1000, 10));
		expect(lat).not.toBeCloseTo(50.2, 2);
		expect(lon).not.toBeCloseTo(14.3, 2);
		expect(h).toBeCloseTo(1250.75, 5);
	});
	it('moves more precisely near the ground and at narrow zoom, with a finite scale below the ground', () => {
		expect(touchMetresPerPixel(20, 55, 800)).toBeLessThan(touchMetresPerPixel(200, 55, 800));
		expect(touchMetresPerPixel(20, 5, 800)).toBeLessThan(touchMetresPerPixel(20, 55, 800));
		expect(touchMetresPerPixel(-1, 55, 800)).toBeGreaterThan(0);
	});
});
