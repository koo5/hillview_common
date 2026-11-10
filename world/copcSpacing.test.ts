import { expect, test } from 'vitest';
import { levelSpacing } from './copcSource';

test('a level halves the root spacing, in metres through the unit scale (ui06)', () => {
	expect(levelSpacing(2.4, 1, 0)).toBe(2.4);
	expect(levelSpacing(2.4, 1, 5)).toBeCloseTo(0.075, 12);    // 2.4 m at the root, 7.5 cm five levels down
	expect(levelSpacing(1, 1.1354499290524107, 3)).toBeCloseTo(0.14193124113, 10);   // a run's tree in solve units
});

test('a spacing that cannot be one is refused, not shown as a number', () => {
	for (const bad of [0, -1, NaN, Infinity]) expect(() => levelSpacing(bad, 1, 0)).toThrow(/spacing/);
	for (const bad of [0, -2, NaN]) expect(() => levelSpacing(1, bad, 0)).toThrow(/scale/);
	for (const bad of [-1, 0.5, NaN]) expect(() => levelSpacing(1, 1, bad)).toThrow(/depth/);
});
