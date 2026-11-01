import { expect, test } from 'vitest';
import { Vector3 } from 'three';
import { boundedFlySpeed, savedFlySpeed, DEFAULT_FLY_MPS, integrateFlyMotion, Flight, FlyKeys, savedFlyLayout, zoomedFov } from './flight';

test('metric preference has one default and bounded physical range', () => {
	expect(DEFAULT_FLY_MPS).toBe(5);
	for (const invalid of [null, '', 'bad', '-1', '0', 'Infinity']) expect(savedFlySpeed(invalid)).toBe(5);
	expect(savedFlySpeed('3.5')).toBe(3.5);
	expect(boundedFlySpeed(.0001)).toBe(.001);
	expect(boundedFlySpeed(100000)).toBe(10000);
});

test('equal real elapsed time produces equal metres and velocity at 5–120 fps', () => {
	const rate = -Math.log(.02), duration = 4, speed = 5;
	const expected = speed * (duration - (1 - Math.exp(-rate * duration)) / rate);
	for (const fps of [5, 10, 20, 60, 120]) {
		const velocity = new Vector3(), position = new Vector3();
		for (let i = 0; i < duration * fps; i++) position.add(integrateFlyMotion(velocity, new Vector3(0, 0, -1), speed, 1 / fps));
		expect(position.length()).toBeCloseTo(expected, 9);
		expect(velocity.length()).toBeCloseTo(speed * (1 - Math.exp(-rate * duration)), 9);
	}
});

test('diagonal thrust is capped; reducing the speed caps existing momentum immediately', () => {
	const velocity = new Vector3(), diagonal = new Vector3(1, 1, -1);
	for (let i = 0; i < 120; i++) integrateFlyMotion(velocity, diagonal.clone(), 5, 1 / 30);
	expect(velocity.length()).toBeCloseTo(5, 5);
	const displacement = integrateFlyMotion(velocity, diagonal.clone(), .25, .2);
	expect(velocity.length()).toBeLessThanOrEqual(.25 + 1e-12);
	expect(displacement.length()).toBeLessThanOrEqual(.05 + 1e-12);
});

test('release easing displacement is cadence independent and partial touch thrust remains proportional', () => {
	const positions: number[] = [];
	for (const fps of [5, 60]) {
		const velocity = new Vector3(), position = new Vector3();
		for (let i = 0; i < fps * 2; i++) position.add(integrateFlyMotion(velocity, new Vector3(0, 0, -.5), 4, 1 / fps));
		for (let i = 0; i < fps; i++) position.add(integrateFlyMotion(velocity, new Vector3(), 4, 1 / fps));
		positions.push(position.z);
		expect(velocity.length()).toBeLessThan(.04);
	}
	expect(positions[0]).toBeCloseTo(positions[1], 9);
});

test('keys are read by physical key, as the layout names them; only flight keys say so', () => {
	const k = new FlyKeys('qwerty');
	expect(k.press('KeyW')).toBe(true);
	expect(k.press('KeyD')).toBe(true);
	expect(k.thrust()).toEqual([1, 0, -1]);
	expect(k.flying).toBe(true);
	expect(k.press('KeyP')).toBe(false);
	k.release('KeyW'); k.release('KeyD');
	expect(k.flying).toBe(false);
	expect(k.press('KeyQ')).toBe(true);
	expect(k.roll()).toBe(1);
	k.clear();
	expect(k.roll()).toBe(0);
	const c = new FlyKeys('colemak');
	expect(c.press('KeyU')).toBe(true);
	expect(c.down('level')).toBe(true);
	expect(new FlyKeys('qwerty').press('KeyU')).toBe(false);
	expect(savedFlyLayout('colemak')).toBe('colemak');
	expect(savedFlyLayout('dvorak')).toBe('qwerty');
});

test('Z and X zoom in equal steps, within bounds; other keys are no zoom', () => {
	const inOnce = zoomedFov(55, 'KeyZ')!;
	expect(inOnce).toBeLessThan(55);
	expect(zoomedFov(inOnce, 'KeyX')).toBeCloseTo(55, 9);
	expect(zoomedFov(0.1, 'KeyZ')).toBe(0.1);
	expect(zoomedFov(119, 'KeyX')).toBe(120);
	expect(zoomedFov(55, 'KeyW')).toBeNull();
});

test('a flight moves the camera along its own axes and comes to rest when the keys are let go', async () => {
	const THREE = await import('three');
	const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
	const f = new Flight(THREE, new FlyKeys('qwerty'), 5);
	f.keys.press('KeyW');
	for (let i = 0; i < 60; i++) f.step(camera, 1 / 30);
	expect(camera.position.z).toBeLessThan(-5);
	expect(Math.abs(camera.position.x)).toBeLessThan(1e-9);
	f.keys.release('KeyW');
	let moving = true;
	for (let i = 0; i < 600 && moving; i++) moving = f.step(camera, 1 / 30);
	expect(moving).toBe(false);
	f.keys.press('KeyQ');
	f.step(camera, 0.5);
	expect(camera.up.clone().applyQuaternion(camera.quaternion).x).not.toBe(0);
	f.stop();
	expect(f.step(camera, 1 / 30)).toBe(false);
	// a touch pad's thrust flies like a key; letting it go stops its own axis
	const before = camera.position.clone();
	expect(f.step(camera, 0.5, { thrust: [0, 1, 0] })).toBe(true);
	expect(camera.position.distanceTo(before)).toBeGreaterThan(0);
	f.halt({ y: true });
	expect(f.step(camera, 1 / 30)).toBe(false);
});
