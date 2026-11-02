/**
 * Names over a scene, a frame at a time (moved from the workbench's run viewer, recon ea07): project them, ask the
 * frame's depth which are hidden (DepthProbe, read back a frame or more later), lay them out and paint them on a
 * canvas over the WebGL one -- worldLabels' parts, put together as the run viewer always did. The run viewer and the
 * public scene both draw names with it; what names there are (a LabelPool, a map's names) is the caller's.
 */
import type * as THREE_NS from 'three';
import { DepthProbe, FONT, arrange, liftOf, paint, project, ridgeCyOf, type Judged, type Named, type Projected } from './worldLabels';
import type { Relief } from './relief';

type Three = typeof THREE_NS;

export type NamesFrame = {
	renderer: THREE_NS.WebGLRenderer;
	camera: THREE_NS.PerspectiveCamera;
	/** every name this frame could show, in scene metres */
	list: Named[];
	/** the frame's depth (null: paint with the last verdicts, ask nothing) and the height of the target it is from */
	depth: THREE_NS.Texture | null;
	depthHeight: number;
	reversed: boolean;
	/** the vertex shader's relief, when it bends the drawn ground (relief.ts) */
	relief: Relief | null;
	/** the view's magnification (worldLabels' zoomOf) */
	zoom: number;
};

export class WorldNames {
	private probe: DepthProbe | null = null;
	private vis = new Map<string, Judged>();
	private textW = new Map<string, number>();
	/**
	 * When the frame behind the latest verdict was drawn. The verdict arrives a read-back later -- on a real GPU a
	 * frame or two, in headless software GL 5-15 s -- so "settled" waits for one taken after the view went quiet.
	 * Without that, a check read the verdict from before the far terrain had loaded and took 1,600 of 1,650 names
	 * for seen (2026-10-02).
	 */
	judgedAt = 0;
	/** a verdict arrived since the last paint: paint again, even on a still view */
	paintPending = false;
	/** why names are not hidden by the scene, when they cannot be */
	note = '';

	constructor(private THREE: Three, private o: {
		/** every verdict, with the names it is about (a check reads them: the workbench's names_check) */
		onVerdict?: (items: Projected[], z: Float32Array) => void;
	} = {}) {}

	/** the probe can judge here (a browser that reads the depth back) */
	get judging(): boolean {
		return !!this.probe?.ok;
	}

	/** an empty canvas at the scene's size; its 2D context, scaled to CSS pixels */
	private surface(canvas: HTMLCanvasElement, W: number, H: number): CanvasRenderingContext2D | null {
		const dpr = window.devicePixelRatio || 1;
		if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
			canvas.width = Math.round(W * dpr);
			canvas.height = Math.round(H * dpr);
		}
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		this.paintPending = false;
		return ctx;
	}

	/** no names: the canvas emptied */
	clear(canvas: HTMLCanvasElement, W: number, H: number) {
		this.surface(canvas, W, H);
	}

	/** project, probe, lay out and paint the names; how many were placed, judged seen and considered */
	draw(canvas: HTMLCanvasElement, W: number, H: number, f: NamesFrame): { placed: number; seen: number; items: number } | null {
		const ctx = this.surface(canvas, W, H);
		if (!ctx) return null;
		const { camera } = f;
		let items = project(f.list, camera.matrixWorldInverse.elements, camera.projectionMatrix.elements,
			camera.position.toArray(), W, H, f.relief, f.zoom);
		// best first, so a crowded view spends the probe's budget on the names that would win
		items.sort((a, b) => b.n.priority - a.n.priority || a.depth - b.depth);
		if (items.length > DepthProbe.MAX) items = items.slice(0, DepthProbe.MAX);
		if (!this.probe) this.probe = new DepthProbe(this.THREE);
		const probe = this.probe;
		if (f.depth && probe.ok && !probe.busy) {
			const snap = items;
			const issued = performance.now();
			const p5 = camera.projectionMatrix.elements[5];
			probe.run(f.renderer, f.depth, f.depthHeight, snap, camera.near, camera.far, f.reversed)?.then((z) => {
				this.paintPending = true;
				if (!z) {
					this.note = 'names are not hidden by the scene here (this browser cannot read the depth back)';
					return;
				}
				if (this.vis.size > 50_000) this.vis.clear();
				snap.forEach((it, i) => this.vis.set(it.n.id,
					{ seen: z[i * 3] > 0.5, own: z[i * 3 + 1], lift: liftOf(z[i * 3 + 2], it.v, p5) }));
				this.judgedAt = issued;
				this.o.onVerdict?.(snap, z);
			});
		}
		// without a probe every name shows: better than none, and the note says why
		const vis: Map<string, Judged> = probe.ok ? this.vis
			: new Map(items.map((it) => [it.n.id, { seen: true, own: -1, lift: null }]));
		// a hidden place's hint stands on the ridge the last verdict found above it
		const p5now = camera.projectionMatrix.elements[5];
		for (const it of items) {
			const j = vis.get(it.n.id);
			if (j && !j.seen) it.ridgeCy = ridgeCyOf(it.v, j.lift, p5now, H);
		}
		ctx.font = FONT;
		const measure = (t: string) => {
			let w = this.textW.get(t);
			if (w === undefined) {
				w = ctx.measureText(t).width;
				this.textW.set(t, w);
			}
			return w;
		};
		const placed = arrange(items, vis, measure, W, H);
		paint(ctx, placed);
		let seen = 0;
		for (const it of items) if (vis.get(it.n.id)?.seen) seen++;
		return { placed: placed.length, seen, items: items.length };
	}

	dispose() {
		this.probe?.dispose();
		this.probe = null;
	}
}
