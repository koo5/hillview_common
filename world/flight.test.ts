import { expect, test } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { boundedFlySpeed, savedFlySpeed, flySpeedLabel, DEFAULT_FLY_MPS, earthUpThrust, integrateFlyMotion, Flight, FlyKeys, pathOffsetM,
	savedFlyLayout, zoomedFov, ZOOM_PLUS_MINUS, ZOOM_ZX } from './flight';

test('metric preference has one default and bounded physical range', () => {
	expect(DEFAULT_FLY_MPS).toBe(5);
	for (const invalid of [null, '', 'bad', '-1', '0', 'Infinity']) expect(savedFlySpeed(invalid)).toBe(5);
	expect(savedFlySpeed('3.5')).toBe(3.5);
	expect(boundedFlySpeed(.0001)).toBe(.001);
	expect(boundedFlySpeed(100000)).toBe(100000);
	expect(boundedFlySpeed(1e9)).toBe(1_000_000);
	expect(savedFlySpeed('250000')).toBe(250000);
	expect([5, 999, 1000, 1500, 1_000_000].map(flySpeedLabel)).toEqual(['5 m/s', '999 m/s', '1 km/s', '1.5 km/s', '1000 km/s']);
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
	const inOnce = zoomedFov(55, { code: 'KeyZ', key: 'z' }, ZOOM_ZX)!;
	expect(inOnce).toBeLessThan(55);
	expect(zoomedFov(inOnce, { code: 'KeyX', key: 'x' }, ZOOM_ZX)).toBeCloseTo(55, 9);
	expect(zoomedFov(0.1, { code: 'KeyZ', key: 'z' }, ZOOM_ZX)).toBe(0.1);
	expect(zoomedFov(119, { code: 'KeyX', key: 'x' }, ZOOM_ZX)).toBe(120);
	expect(zoomedFov(55, { code: 'KeyW', key: 'w' }, ZOOM_ZX)).toBeNull();
	// ZOOM_ZX is a position: a German Z position types y and still zooms
	expect(zoomedFov(55, { code: 'KeyZ', key: 'y' }, ZOOM_ZX)).toBeCloseTo(inOnce, 9);
	// Hillview's scene goes by the character: + or = (the keypad's types +) narrows, - widens; its Z and X are the app's
	expect(zoomedFov(55, { code: 'Equal', key: '=' }, ZOOM_PLUS_MINUS)).toBeCloseTo(inOnce, 9);
	expect(zoomedFov(55, { code: 'NumpadAdd', key: '+' }, ZOOM_PLUS_MINUS)).toBeCloseTo(inOnce, 9);
	expect(zoomedFov(inOnce, { code: 'Minus', key: '-' }, ZOOM_PLUS_MINUS)).toBeCloseTo(55, 9);
	expect(zoomedFov(55, { code: 'KeyZ', key: 'z' }, ZOOM_PLUS_MINUS)).toBeNull();
	// Czech QWERTZ: + is on Digit1, and the Equal position types the dead key ´
	expect(zoomedFov(55, { code: 'Digit1', key: '+' }, ZOOM_PLUS_MINUS)).toBeCloseTo(inOnce, 9);
	expect(zoomedFov(55, { code: 'Equal', key: '´' }, ZOOM_PLUS_MINUS)).toBeNull();
	expect(zoomedFov(55, { code: 'Equal', key: 'Dead' }, ZOOM_PLUS_MINUS)).toBeNull();
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

test('an echo between two reports is on the path: the far-view e2e landing, 2026-11-08', () => {
	// two of the flight's reports 1.5 km apart, and the map's echo that landed it: 8.7 m short of the later report
	const path = [{ lat: 49.98622101136398, lon: 14.692625999450685 }, { lat: 49.979393126375406, lon: 14.710755633316046 }];
	const echo = { lat: 49.97943256661632, lon: 14.710650444030763 };
	expect(pathOffsetM(path, echo.lat, echo.lon)).toBeLessThan(0.1);
	// what the points alone said: well past a map pixel at zoom 15 (3.1 m)
	expect(pathOffsetM([path[1]], echo.lat, echo.lon)).toBeCloseTo(8.7, 1);
});

test('path offset: no path, one point, off the side, and past the ends', () => {
	const mLat = 111_320, lat = 50, mLon = mLat * Math.cos((lat * Math.PI) / 180);
	expect(pathOffsetM([], lat, 14)).toBe(Infinity);
	// north-south distances to a millimetre: Mercator's scale changes over them (0.08 mm in 30 m); east-west exact
	expect(pathOffsetM([{ lat, lon: 14 }], lat + 30 / mLat, 14)).toBeCloseTo(30, 3);
	// an east-west leg 1 km long
	const path = [{ lat, lon: 14 }, { lat, lon: 14 + 1000 / mLon }];
	expect(pathOffsetM(path, lat + 20 / mLat, 14 + 500 / mLon)).toBeCloseTo(20, 3);  // beside its middle
	expect(pathOffsetM(path, lat, 14 - 40 / mLon)).toBeCloseTo(40, 6);              // before its start
	expect(pathOffsetM(path, lat, 14 + 1050 / mLon)).toBeCloseTo(50, 6);            // past its end, not on the line's extension
	// the nearest of several legs (a degree of longitude is measured at the asked point's latitude, 500 m north)
	const bent = [...path, { lat: lat + 1000 / mLat, lon: 14 + 1000 / mLon }];
	const q = lat + 500 / mLat, mLonQ = mLat * Math.cos((q * Math.PI) / 180);
	expect(pathOffsetM(bent, q, 14 + 1000 / mLon + 3 / mLonQ)).toBeCloseTo(3, 3);
});

test('the path is the map\'s line, straight in Web Mercator: a fast diagonal pan cut short is on it (RECON-UI, 11-10)', () => {
	// one report gap at 1000 km/s (300 km), bearing 45 from Prague; Leaflet's pan stopped at its Mercator mid-point
	const path = [{ lat: 50.08, lon: 14.42 }, { lat: 51.947854, lon: 17.515452 }];
	expect(pathOffsetM(path, 51.023333, 15.967726)).toBeLessThan(1);   // 755.6 m off the straight line in degrees
	const side = pathOffsetM(path, 51.016974, 15.977834);               // a real move 1 km to the side still reads 1 km
	expect(side).toBeGreaterThan(990); expect(side).toBeLessThan(1010);
});

test('the height stick thrusts along the earth\'s up, not the camera\'s, whichever way it looks or is rolled', () => {
	const up = new Vector3(0.01, -0.02, 1).normalize(); // the local vertical 20 km from the frame's origin leans a little
	const camera = new PerspectiveCamera();
	for (const [look, roll] of [[[0, 1, 0], 0], [[0, 1, -1], 0], [[0, 0.001, -1], 0], [[1, 1, 0.5], 0.4], [[-1, 0.2, -0.3], -1.2]] as const) {
		camera.up.set(0, 0, 1);
		camera.position.set(0, 0, 0);
		camera.lookAt(look[0], look[1], look[2]);
		camera.rotateZ(roll);
		const world = new Vector3(...earthUpThrust(up, camera.quaternion, 0.7)).applyQuaternion(camera.quaternion);
		expect(world.distanceTo(up.clone().multiplyScalar(0.7))).toBeCloseTo(0, 9);
	}
	// what it replaces: looking straight down, the camera's own up lies flat, so the stick slid the ship sideways
	camera.up.set(0, 0, 1);
	camera.lookAt(0, 0.001, -1);
	expect(Math.abs(new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).z)).toBeLessThan(0.01);
});
