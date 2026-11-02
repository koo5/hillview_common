import { describe, expect, test } from 'vitest';
import { formatBytes, formatElapsed, layerProgress, RateWindow } from './loadProgress';
import type { RequestInfo } from './worldRequests';

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

describe('layerProgress', () => {
	const row = (kind: RequestInfo['kind'], state: RequestInfo['state'], wanted = true): RequestInfo =>
		({ id: `${kind}${Math.random()}`, scope: 's', label: kind, kind, url: '', priority: 0, wanted, state, attempts: 0, createdAt: 0 });
	test('says each layer as loaded of wanted, in a fixed order, failures said', () => {
		const p = layerProgress([row('ortho', 'loaded'), row('terrain', 'loaded'), row('terrain', 'loading'),
			row('terrain', 'failed'), row('labels', 'queued'), row('terrain', 'loaded', false)])!;
		expect(p.overall).toBe('terrain 1/3 (1 failed) · orthophoto 1/1 · names 0/1');
		expect(p.compact).toBe(p.overall);
		expect(p.step).toBe('');
	});
	test('is null once nothing is pending, so the overlay hides on a complete view', () => {
		expect(layerProgress([row('terrain', 'loaded'), row('ortho', 'failed')])).toBeNull();
		expect(layerProgress([row('terrain', 'loading', false)])).toBeNull();
		expect(layerProgress([])).toBeNull();
	});
});
