import { describe, expect, it } from 'vitest';
import { RELIEF_CHUNK, RELIEF_DECL, relieved, unrelieved } from './relief';

const R = 6_371_000;

describe('relief, on the CPU as the vertex shader does it', () => {
	it('is the identity at x1 and k 0', () => {
		expect(relieved([10, 20, 30], [0, 0, 0], { exag: 1, k: 0, origin: [0, 0, 0], ref: 0 })).toEqual([10, 20, 30]);
		expect(relieved([10, 20, 30], [0, 0, 0], null)).toEqual([10, 20, 30]);
	});

	it('lifts by k d^2 / 2R from the CAMERA, and stretches the height above the curved ground', () => {
		const r = relieved([0, 10_000, 0], [0, 0, 5], { exag: 1, k: 0.13, origin: [0, 0, 0], ref: 0 });
		expect(r[2]).toBeCloseTo((0.13 * 1e8) / (2 * R), 9);
		// x2 about ref 100: a point at 300 (+ the curvature drop put back) stands 200 higher
		const e = relieved([0, 10_000, 300], [0, 0, 0], { exag: 2, k: 0, origin: [0, 0, 0], ref: 100 });
		expect(e[2]).toBeCloseTo(300 + (300 + 1e8 / (2 * R) - 100), 6);
	});

	it('is the same formula as the shader (change one, change the other)', () => {
		const src = RELIEF_CHUNK;
		expect(src).toContain('float drop = dot( rel.xy, rel.xy ) / ( 2.0 * 6371000.0 );');
		expect(src).toContain('wp.z += ( uExag - 1.0 ) * ( rel.z + drop - uExagRef );');
		expect(src).toContain('vec2 fromCam = wp.xy - cameraPosition.xy;');
		expect(src).toContain('wp.z += uRefK * dot( fromCam, fromCam ) / ( 2.0 * 6371000.0 );');
	});
});

describe('relief undone', () => {
	it('a pick on the stretched, lifted surface gives the point it was drawn from', () => {
		const r = { exag: 3, k: 0.13, origin: [100, -200, 250] as [number, number, number], ref: 240 };
		const cam: [number, number, number] = [0, 0, 260];
		for (const s of [[30_000, 12_000, 410], [-5000, 800, 180], [0, 50, 260]] as [number, number, number][]) {
			const back = unrelieved(relieved(s, cam, r), cam, r);
			for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(s[i], 6);
		}
		expect(unrelieved([1, 2, 3], cam, null)).toEqual([1, 2, 3]);
	});

	it('declares every uniform the chunk reads', () => {
		for (const u of ['uExag', 'uExagOrigin', 'uExagRef', 'uRefK']) {
			expect(RELIEF_CHUNK).toContain(u);
			expect(RELIEF_DECL).toContain(`uniform`);
			expect(RELIEF_DECL).toContain(` ${u};`);
		}
	});
});
