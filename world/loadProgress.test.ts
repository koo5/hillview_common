import { describe, expect, test } from 'vitest';
import { formatBytes, formatElapsed, RateWindow } from './loadProgress';

describe('load progress text', () => {
	test('bytes read in the unit a reader compares', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(999)).toBe('999 B');
		expect(formatBytes(1500)).toBe('2 kB');
		expect(formatBytes(48_900_000)).toBe('48.9 MB');
		expect(formatBytes(1_520_000_000)).toBe('1.52 GB');
	});
	test('elapsed is minutes and seconds, never negative', () => {
		expect(formatElapsed(54_900)).toBe('0:54');
		expect(formatElapsed(272_000)).toBe('4:32');
		expect(formatElapsed(-5)).toBe('0:00');
	});
	test('the rate drops every expired sample, whatever order they arrived in', () => {
		// CODEX-SMALL's repro: a late-finishing read listed after an early one kept the stale bytes in the window
		const w = new RateWindow(5000);
		w.add(9000, 100);
		w.add(1000, 1000);
		expect(w.rate(10000)).toBe(20);
		w.add(9500, 400);
		expect(w.rate(10000)).toBe(100);
		expect(w.rate(20000)).toBe(0);
	});
});
