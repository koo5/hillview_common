/**
 * The pool of names round the camera (2026-10-02): OSM peaks, towers, masts and places, each with an ellipsoidal
 * height, from a disc query in chunks -- the workbench's /terrain/labels or earth's /t/{release}/names, which
 * answer alike -- placed in the world frame and handed to worldLabels as `Named`. Moved here from the workbench for
 * the public scene (recon ea07).
 */
import { labelPriority } from '../terrain/peakLabels';
import { Frame, type Vec3 } from './geodesy';
import { TERRAIN_KINDS, type Named } from './worldLabels';
import { WorldRequests, RequestFailure, responseOrThrow, requestHeaders } from './worldRequests';

const R_EARTH_M = 6_371_000;

type PoolItem = {
	id: string; name: string; kind: string; lat: number; lon: number; h: number;
	priority: number; text: string;
	/** placed in the world frame at max(h, the drawn ground), redone when the ground changes */
	p?: Vec3; liftVer: number;
};

type PoolOptions = {
	requests?: WorldRequests;
	/** /terrain/labels, without its query */
	url: string;
	frame: Frame;
	radiusM?: number;
	/** how far the camera goes before the pool is asked again round it */
	recentreM?: number;
	chunks?: number;
	/** above this (metres over the ellipsoid) the pool is not asked for: from orbit a 120 km disc
	 * of peak names is a speck, and every 20 km of flight would be another Overpass round */
	maxAltitudeM?: number;
	onChange?: () => void;
};

/** what one entry of /terrain/labels carries */
type PoolEntry = {
	name: string; kind?: string; lat: number; lon: number; h: number | null;
	ele?: number | null; ele_estimated?: boolean; prominence?: number | null; population?: number | null;
};

export class LabelPool {
	private items = new Map<string, PoolItem>();
	private centre: [number, number] | null = null;
	private requests: WorldRequests;
	private requestScope: string;
	private ownsRequests: boolean;
	private disposed = false;
	error = '';
	version = 0;
	readonly o: Required<Omit<PoolOptions, 'onChange' | 'requests'>> & Pick<PoolOptions, 'onChange' | 'requests'>;

	constructor(opts: PoolOptions) {
		this.o = { radiusM: 120_000, recentreM: 20_000, chunks: 4, maxAltitudeM: 30_000, ...opts };
		this.requests = opts.requests ?? new WorldRequests();
		this.ownsRequests = !opts.requests;
		this.requestScope = this.requests.scope('labels');
	}

	get stats() {
		const rows = this.requests.snapshot().filter(r => r.scope === this.requestScope && r.wanted);
		const pending = rows.some(r => ['queued', 'loading', 'retrying'].includes(r.state));
		return { n: this.items.size, loading: pending, error: rows.map(r => r.error).filter(Boolean).join(' · ') };
	}

	update(camWorld: Vec3) {
		if (this.disposed) return;
		const [lat, lon, h] = this.o.frame.toGeodetic(...camWorld);
		if (h > this.o.maxAltitudeM) return;
		if (this.centre && haversine(lat, lon, ...this.centre) < this.o.recentreM) return;
		this.centre = [lat, lon];
		this.error = '';
		for (const [k, it] of this.items)
			if (haversine(lat, lon, it.lat, it.lon) > 1.6 * this.o.radiusM) this.items.delete(k);
		this.version++;
		this.requests.reconcile(this.requestScope, Array.from({ length: this.o.chunks }, (_, c) => {
			const q = `lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&radius_m=${this.o.radiusM}&chunk=${c}&chunks=${this.o.chunks}`;
			const url = `${this.o.url}${this.o.url.includes('?') ? '&' : '?'}${q}`;
			return {
				id: url, url, label: `Names near ${lat.toFixed(3)}, ${lon.toFixed(3)} · part ${c + 1}/${this.o.chunks}`,
				kind: 'labels' as const, priority: c,
				run: async (signal: AbortSignal, requestId: string) => {
					const r = await responseOrThrow(url, signal, { headers: requestHeaders(url, undefined, requestId) });
					const d = await r.json() as { labels: PoolEntry[]; partial?: boolean; failed_tiles?: number };
					signal.throwIfAborted();
					if (this.disposed) return;
					for (const e of d.labels ?? []) this.add(e);
					this.version++;
					this.o.onChange?.();
					if (d.partial) throw new RequestFailure(`Names incomplete: ${d.failed_tiles ?? 'some'} upstream tiles failed`);
				},
				onState: () => { this.o.onChange?.(); }
			};
		}));
	}

	private add(e: PoolEntry) {
		if (e.h == null || !e.name) return;
		const kind = e.kind ?? 'peak';
		const id = `${kind}|${e.name}|${e.lat.toFixed(5)}|${e.lon.toFixed(5)}`;
		if (this.items.has(id)) return;
		// the bench's pill text: a terrain name with a TAGGED elevation says it
		const text = TERRAIN_KINDS.has(kind) && e.ele != null && !e.ele_estimated
			? `${e.name} ${Math.round(e.ele)}` : e.name;
		this.items.set(id, { id, name: e.name, kind, lat: e.lat, lon: e.lon, h: e.h, text, liftVer: -1,
			priority: labelPriority({ kind, prominence: e.prominence, population: e.population }) });
	}

	/**
	 * The pool's names, placed in the world frame -- each at the higher of its own height and the
	 * ground drawn under it (`heightAt`, ellipsoidal; `ver` changes when that ground does), so an
	 * anchor is never inside the hill it names.
	 */
	named(heightAt: ((lat: number, lon: number) => number | null) | null, ver: number, offset: Vec3): Named[] {
		const out: Named[] = [];
		for (const it of this.items.values()) {
			if (!it.p || it.liftVer !== ver) {
				const g = heightAt?.(it.lat, it.lon) ?? null;
				it.p = this.o.frame.fromGeodetic(it.lat, it.lon, g !== null ? Math.max(it.h, g) : it.h);
				it.liftVer = ver;
			}
			out.push({ id: it.id, name: it.name, kind: it.kind, text: it.text, priority: it.priority,
				s: [it.p[0] + offset[0], it.p[1] + offset[1], it.p[2] + offset[2]] });
		}
		return out;
	}

	dispose() {
		this.disposed = true;
		this.requests.release(this.requestScope);
		if (this.ownsRequests) this.requests.dispose();
		this.items.clear();
	}
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const r = Math.PI / 180;
	const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
		Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
	return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
