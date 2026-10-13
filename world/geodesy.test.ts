import { describe, expect, it } from 'vitest';
import { Frame, fromEcef, toEcef } from './geodesy';
import cases from './geodesy-cases.json';

describe('geodesy, the browser half', () => {
	// geodesy-cases.json comes from the Python geodesy.py: points up to ~100 km and 3 km high
	it('puts a lat/lon/h where the API does, and back', () => {
		let worst = 0, back = 0;
		for (const f of cases.frames) {
			const w = new Frame(f.origin[0], f.origin[1], f.origin[2]);
			f.geodetic.forEach(([lat, lon, h], i) => {
				const got = w.fromGeodetic(lat, lon, h);
				for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k] - f.enu[i][k]));
				const [la, lo, hh] = w.toGeodetic(...got);
				back = Math.max(back, Math.abs(la - lat) * 1.1e5, Math.abs(lo - lon) * 7e4, Math.abs(hh - h));
			});
		}
		expect(worst).toBeLessThan(1e-5);
		expect(back).toBeLessThan(1e-4);
	});

	it('the ground falls away from the tangent plane: ~785 m at 100 km', () => {
		const w = new Frame(50.16605, 14.62178, 0);
		const [, n, u] = w.fromGeodetic(50.16605 + (100_000 / 6_371_000) * (180 / Math.PI), 14.62178, 0);
		expect(n).toBeGreaterThan(99_000);
		expect(u).toBeLessThan(-770);
		expect(u).toBeGreaterThan(-800);
	});

	it('ECEF round trip', () => {
		const [la, lo, h] = fromEcef(...toEcef(50.1, 14.6, 321.5));
		expect(Math.abs(la - 50.1)).toBeLessThan(1e-10);
		expect(Math.abs(lo - 14.6)).toBeLessThan(1e-10);
		expect(Math.abs(h - 321.5)).toBeLessThan(1e-6);
	});
});
