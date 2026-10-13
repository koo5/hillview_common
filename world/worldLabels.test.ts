import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { arrange, liftOf, project, ridgeCyOf, toleranceM, verdict, type Named, type Projected } from './worldLabels';

const R = 6_371_000;
const named = (id: string, s: [number, number, number], kind = 'peak', priority = 0): Named =>
	({ id, name: id, kind, text: id, s, priority });

/** a camera at the origin, 2 m up, looking due north (+y), z up */
function northCam(W = 800, H = 600) {
	const cam = new THREE.PerspectiveCamera(60, W / H, 1, 200_000);
	cam.up.set(0, 0, 1);
	cam.position.set(0, 0, 2);
	cam.lookAt(0, 1, 2);
	cam.updateMatrixWorld();
	cam.updateProjectionMatrix();
	return cam;
}

describe('projection', () => {
	it('puts a name straight ahead in the middle, at its distance, and drops what is behind or too far', () => {
		const cam = northCam();
		const items = project(
			[named('ahead', [0, 1000, 2]), named('behind', [0, -1000, 2]), named('street', [0, 2000, 2], 'residential'),
				named('far peak', [0, 119_000, 2])],
			cam.matrixWorldInverse.elements, cam.projectionMatrix.elements, [0, 0, 2], 800, 600, null);
		expect(items.map((i) => i.n.id)).toEqual(['ahead', 'far peak']);
		const a = items[0];
		expect(a.cx).toBeCloseTo(400, 6);
		expect(a.cy).toBeCloseTo(300, 6);
		expect(a.u).toBeCloseTo(0.5, 9);
		expect(a.depth).toBeCloseTo(1000, 6);
		// a peak is judged across its height band, 100 m above and below it: at 1 km, ~5.7 degrees
		const fy = cam.projectionMatrix.elements[5];
		expect(a.vHi - a.v).toBeCloseTo((fy * 100) / 1000 / 2, 3);
		expect(a.v - a.vLo).toBeCloseTo((fy * 100) / 1000 / 2, 3);
	});

	it('a street has no band: only its own pixel decides', () => {
		const cam = northCam();
		const [s] = project([named('street', [0, 500, 2], 'residential')], cam.matrixWorldInverse.elements,
			cam.projectionMatrix.elements, [0, 0, 2], 800, 600, null);
		expect(s.vLo).toBe(s.v);
		expect(s.vHi).toBe(s.v);
	});

	it('follows the relief: refraction raises a far peak on the screen', () => {
		const cam = northCam();
		const p = [named('peak', [0, 80_000, 0])];
		const flat = project(p, cam.matrixWorldInverse.elements, cam.projectionMatrix.elements, [0, 0, 2], 800, 600, null)[0];
		const bent = project(p, cam.matrixWorldInverse.elements, cam.projectionMatrix.elements, [0, 0, 2], 800, 600,
			{ exag: 1, k: 0.13, origin: [0, 0, 0], ref: 0 })[0];
		expect(bent.cy).toBeLessThan(flat.cy);
	});
});

describe('what hides a name', () => {
	const peak = (D: number, own: number, band: number[] = []) => verdict(D, toleranceM('peak', D), own, band);
	it('sky shows it; a ridge well in front hides it; the summit itself is within the window', () => {
		expect(peak(30_000, -1)).toBe(true);
		expect(peak(30_000, 25_000)).toBe(false);
		expect(peak(30_000, 30_000 - toleranceM('peak', 30_000) + 1)).toBe(true);
		// a house 20 m off hides a street 100 m off; the road surface at the anchor does not
		expect(verdict(100, toleranceM('residential', 100), 20, [])).toBe(false);
		expect(verdict(100, toleranceM('residential', 100), 99, [])).toBe(true);
		// a village is an area round its node: the bench's window is 300 m + 3 % at any distance
		// (it calls Horin seen from Melnik with the ground 212 m in front of the node at 900 m)
		expect(verdict(900, toleranceM('village', 900), 688, [])).toBe(true);
		expect(verdict(900, toleranceM('village', 900), 500, [])).toBe(false);
	});

	it('the band: ground at the name\'s distance in ANY row counts; a far hill behind does not', () => {
		// a plain at a grazing angle: the rows jump 26 -> 30.1 -> 45 km; only one lands in the window
		expect(peak(30_000, 26_000, [24_000, 26_000, 30_100, 45_000, -1])).toBe(true);
		expect(peak(30_000, 26_000, [24_000, 26_000, 45_000, -1])).toBe(false);
	});

	it('the probe shader is the same rule (change one, change the other)', () => {
		const src = readFileSync(new URL('./worldLabels.ts', import.meta.url), 'utf8');
		expect(src).toContain('float seen = (own < 0.0 || own >= D - tol) ? 1.0 : 0.0;');
		expect(src).toContain('if (z >= 0.0 && abs(z - D) <= tol) seen = 1.0;');
	});
});

describe('arrangement', () => {
	const at = (id: string, cx: number, cy: number, kind = 'peak', priority = 0, d = 10_000): Projected =>
		({ n: named(id, [0, 0, 0], kind, priority), cx, cy, u: 0, v: 0, vLo: 0, vHi: 0, depth: d, d });
	const measure = (t: string) => t.length * 7;
	/** verdicts as the probe gives them: seen, or hidden behind something `own` metres off */
	const judged = (e: [string, boolean][], own = 5000) =>
		new Map(e.map(([id, seen]) => [id, { seen, own, lift: null }]));

	it('draws only what was probed, best first, and a hidden notable place dim after every visible name', () => {
		const items = [at('small', 100, 300), at('Big', 400, 300, 'peak', 500), at('unprobed', 600, 300),
			at('Town', 250, 300, 'town', 300, 20_000), at('Hamlet', 700, 300, 'village', 50, 5000)];
		items[3].ridgeCy = 260;
		const vis = judged([['small', true], ['Big', true], ['Town', false], ['Hamlet', false]]);
		const placed = arrange(items, vis, measure, 800, 600);
		expect(placed.map((p) => [p.id, p.cls])).toEqual([['Big', 'seen'], ['small', 'seen'], ['Town', 'direction']]);
	});

	it('a hint stands on the ridge of what hides the place, not on the place (Dobříš on Petřín, 2026-10-03)', () => {
		const town = () => at('Dobříš', 400, 330, 'town', 300, 41_700);
		// the place's pixel is on the hill's flank; the hill's top edge is 40 px above it
		const t = town();
		t.ridgeCy = 290;
		const [p] = arrange([t], judged([['Dobříš', false]], 3000), measure, 800, 600);
		expect([p.cls, p.cx, p.cy]).toEqual(['direction', 400, 290]);
		// no ridge found (the occluder fills the picture above): no hint, rather than one on the flank
		expect(arrange([town()], judged([['Dobříš', false]], 3000), measure, 800, 600)).toEqual([]);
		// hidden by foreground clutter (< 1 km, the bench's DIRECTION_MIN_OCCLUDER_M): no hint
		const u = town();
		u.ridgeCy = 290;
		expect(arrange([u], judged([['Dobříš', false]], 400), measure, 800, 600)).toEqual([]);
	});

	it('the ridge is kept as a tan-elevation offset: the same ridge after a 2x zoom', () => {
		// probed at p5 = 2 (vertical fov 53 deg): name at v 0.5, ridge at v 0.55
		const lift = liftOf(0.55, 0.5, 2)!;
		expect(ridgeCyOf(0.5, lift, 2, 600)).toBeCloseTo((1 - 0.55) * 600, 9);
		// zoomed 2x about the centre: the name still at v 0.5, the ridge twice as far above it
		expect(ridgeCyOf(0.5, lift, 4, 600)).toBeCloseTo((1 - 0.6) * 600, 9);
		expect(liftOf(-1, 0.5, 2)).toBeNull();
		expect(ridgeCyOf(0.5, null, 2, 600)).toBeNull();
	});

	it('a street named once per map tile is drawn once nearby, again further off; peaks are never merged', () => {
		const items = [at('Main', 100, 300, 'residential', 0, 50), at('Main', 300, 300, 'residential', 0, 80),
			at('Main', 700, 300, 'residential', 0, 400), at('Baba', 150, 200, 'peak', 0, 1000), at('Baba', 360, 200, 'peak', 0, 2000)];
		items.forEach((it, i) => (it.n.id = `${it.n.id}#${i}`));
		const vis = judged(items.map((it) => [it.n.id, true]));
		const placed = arrange(items, vis, measure, 800, 600);
		expect(placed.filter((p) => p.label === 'Main').map((p) => p.cx)).toEqual([100, 700]);
		expect(placed.filter((p) => p.label === 'Baba').length).toBe(2);
	});

	it('first come wins a crowded spot, and a name the map has faded out takes no room', () => {
		const items = [at('a', 300, 300, 'peak', 100), at('b', 302, 300, 'peak', 50)];
		const vis = judged([['a', true], ['b', true]]);
		expect(arrange(items, vis, measure, 800, 600).map((p) => p.id)).toEqual(['a']);
		items[0].n.alpha = 0;
		expect(arrange(items, vis, measure, 800, 600).map((p) => p.id)).toEqual(['b']);
	});
});
