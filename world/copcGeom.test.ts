import { describe, expect, it } from 'vitest';
import { overlaps, slabHitsBox, slabInFileFrame, type EnuAlignment } from './copcGeom';

// run 8b696c73's real X-Enu-Alignment: a rotation that mixes all three axes and a scale that is
// not 1, which is what makes a transposed R or a dropped scale show up at all
const ENU: EnuAlignment = {
	scale: 1.1354499290524107,
	R: [
		[-0.5450962126144416, -0.8028313636655461, -0.24152002092644662],
		[0.017788195596438027, 0.276941529342995, -0.9607221083240387],
		[0.8381847642917487, -0.5279821879950902, -0.13667885743268005]
	],
	t: [3.604718693680317, 3.516560419984844, -3.7627209665885983]
};

const toEnu = (p: number[], a = ENU) => [
	a.scale * (a.R[0][0] * p[0] + a.R[0][1] * p[1] + a.R[0][2] * p[2]) + a.t[0],
	a.scale * (a.R[1][0] * p[0] + a.R[1][1] * p[1] + a.R[1][2] * p[2]) + a.t[1],
	a.scale * (a.R[2][0] * p[0] + a.R[2][1] * p[1] + a.R[2][2] * p[2]) + a.t[2]
];

describe('slabInFileFrame', () => {
	it('selects exactly the points the ENU test selects', () => {
		// The claim: testing a point in solve coordinates against the carried plane is the SAME
		// question as testing its ENU image against the original plane. Anything less than exact
		// agreement is a wrong plane, and a wrong plane still draws a plausible section.
		const centre: [number, number, number] = [2, -1, 0.5];
		const normal: [number, number, number] = [0.6, 0.8, 0]; // unit; a walk direction
		const half = 0.35;
		const slab = slabInFileFrame(ENU, centre, normal, half);

		let inside = 0;
		let disagree = 0;
		// deterministic sweep rather than random: a seeded failure has to be reproducible
		for (let i = 0; i < 40; i++) {
			for (let j = 0; j < 40; j++) {
				for (let k = 0; k < 25; k++) {
					const p = [-20 + i, -20 + j, -10 + k * 0.8];
					const e = toEnu(p);
					const truth =
						Math.abs(
							(e[0] - centre[0]) * normal[0] +
								(e[1] - centre[1]) * normal[1] +
								(e[2] - centre[2]) * normal[2]
						) <= half;
					const carried =
						Math.abs(p[0] * slab.n[0] + p[1] * slab.n[1] + p[2] * slab.n[2] + slab.d) <= half;
					if (truth) inside++;
					if (truth !== carried) disagree++;
				}
			}
		}
		expect(inside).toBeGreaterThan(100); // the sweep actually crosses the slab
		expect(disagree).toBe(0);
	});

	it('is the plain plane when there is no alignment', () => {
		const s = slabInFileFrame(null, [1, 2, 3], [0, 0, 1], 0.5);
		expect(s.n).toEqual([0, 0, 1]);
		expect(s.d).toBeCloseTo(-3, 12);
		// a point at z = 3.4 is inside a half-thickness of 0.5, one at 3.6 is not
		expect(Math.abs(3.4 + s.d) <= s.half).toBe(true);
		expect(Math.abs(3.6 + s.d) <= s.half).toBe(false);
	});

	it('keeps the half-thickness in metres, so the scale rides in the normal', () => {
		const s = slabInFileFrame(ENU, [0, 0, 0], [1, 0, 0], 0.35);
		expect(s.half).toBe(0.35);
		// |n'| == scale for a unit input normal and a rotation
		expect(Math.hypot(...s.n)).toBeCloseTo(ENU.scale, 9);
	});
});

describe('slabHitsBox', () => {
	const unit = [0, 0, 0, 1, 1, 1];
	it('keeps a cube the plane passes through', () => {
		expect(slabHitsBox({ n: [1, 0, 0], d: -0.5, half: 0.01 }, unit)).toBe(true);
	});
	it('drops a cube the plane misses', () => {
		expect(slabHitsBox({ n: [1, 0, 0], d: -5, half: 0.01 }, unit)).toBe(false);
	});
	it('keeps a cube the plane only grazes — conservative, never drops a wanted point', () => {
		// plane at x = 1, the cube's far face
		expect(slabHitsBox({ n: [1, 0, 0], d: -1, half: 0 }, unit)).toBe(true);
	});
	it('accounts for the cube extent along a diagonal normal', () => {
		const n: [number, number, number] = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
		// the unit cube's corner-to-centre reach along this normal is 3*(0.5/sqrt3) = 0.866
		expect(slabHitsBox({ n, d: -(0.5 * 3) / Math.sqrt(3) - 0.8, half: 0 }, unit)).toBe(true);
		expect(slabHitsBox({ n, d: -(0.5 * 3) / Math.sqrt(3) - 0.9, half: 0 }, unit)).toBe(false);
	});
});

describe('overlaps', () => {
	it('counts touching as overlapping', () => {
		expect(overlaps([0, 0, 0, 1, 1, 1], [1, 0, 0, 2, 1, 1])).toBe(true);
	});
	it('separates disjoint boxes on any axis', () => {
		expect(overlaps([0, 0, 0, 1, 1, 1], [2, 0, 0, 3, 1, 1])).toBe(false);
		expect(overlaps([0, 0, 0, 1, 1, 1], [0, 0, 2, 1, 1, 3])).toBe(false);
	});
});
