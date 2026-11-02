import type { RequestInfo, RequestKind } from './worldRequests';

/** A long load a reader follows (the world's refinement): what it converges to, the step in flight, its re-plans
 * and the bytes it costs. The operator, 2026-10-24: messages that alternated between blocks and points could not tell
 * progress from a loop, and "mainly the total" bytes tells what the page needs from the network. */
export type LoadProgress = { overall: string; step: string; restarts: string; bytes: string; rate: string; compact?:string };

const LAYERS: [RequestKind, string][] = [['terrain', 'terrain'], ['ortho', 'orthophoto'], ['models', 'buildings'],
	['labels', 'names'], ['map', 'map'], ['points', 'point cloud'], ['world', 'world'], ['cameras', 'cameras'], ['images', 'images']];

/** Where each layer of the view stands, as its requests say it: loaded of wanted ("terrain 180/218 · orthophoto
 * 150/219"), for a scene with no long load of its own (the public one). Null once nothing is pending, so the overlay
 * still hides on a complete view. No bytes: earth and the atlas are other origins, whose sizes Resource Timing
 * reports as 0 without Timing-Allow-Origin. */
export function layerProgress(rows: readonly RequestInfo[]): LoadProgress | null {
	const wanted = rows.filter(r => r.wanted);
	if (!wanted.some(r => r.state === 'queued' || r.state === 'loading' || r.state === 'retrying')) return null;
	const line = LAYERS.flatMap(([kind, name]) => {
		const of = wanted.filter(r => r.kind === kind);
		if (!of.length) return [];
		const loaded = of.filter(r => r.state === 'loaded').length, failed = of.filter(r => r.state === 'failed').length;
		return [`${name} ${loaded}/${of.length}${failed ? ` (${failed} failed)` : ''}`];
	}).join(' · ');
	return { overall: line, step: '', restarts: '', bytes: '', rate: '', compact: line };
}

export const formatBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB`
	: n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${Math.round(n)} B`;
export const formatElapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Bytes per second over the last `windowMs`. Samples arrive out of order -- the initial history is sorted by start
 * time and concurrent reads finish in any order -- so every expired sample is dropped, not only those in front. */
export class RateWindow {
	private samples: [number, number][] = [];
	constructor(readonly windowMs = 5000) {}
	add(at: number, bytes: number) { this.samples.push([at, bytes]); }
	rate(now: number) {
		this.samples = this.samples.filter(([at]) => at >= now - this.windowMs);
		return this.samples.reduce((a, [, b]) => a + b, 0) / (this.windowMs / 1000);
	}
}

/** Bytes this page received, from Resource Timing: the page document and every same-origin response its main
 * thread fetched (octree ranges, tiles, images), not only one layer's. A cached response costs nothing and counts 0;
 * a cross-origin one without Timing-Allow-Origin reports 0 too; a worker's own fetches (the decoder's WASM) are in
 * the worker's timeline, not this one. So: what our servers sent this page's thread. Observers still receive entries
 * after the buffer fills. */
export function byteMeter(matches: (url: string) => boolean, windowMs = 5000) {
	let total = 0, matched = 0;
	const recent = new RateWindow(windowMs);
	const add = (e: PerformanceEntry) => {
		const r = e as PerformanceResourceTiming, bytes = r.transferSize || 0;
		if (!bytes) return;
		total += bytes;
		if (matches(r.name)) matched += bytes;
		recent.add(r.responseEnd, bytes);
	};
	for (const e of performance.getEntriesByType('navigation')) add(e);
	for (const e of performance.getEntriesByType('resource')) add(e);
	const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) add(e); });
	observer.observe({ type: 'resource' });
	return {
		snapshot(now = performance.now()) { return { total, matched, rate: recent.rate(now) }; },
		dispose() { observer.disconnect(); }
	};
}
