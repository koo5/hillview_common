/**
 * The public atlas in a scene (recon ea05 step 4): a published world snapshot read from its static files
 * (atlas.hillview.cz: <channel>.json names the version, w/<resolution>/<key>/ holds version.json and the
 * COPC tree), streamed as the workbench streams it -- planned by what the camera sees (cameraMeasure,
 * planWorldView), read in batches through the request scheduler (readBlocks), held within a budget
 * (WorldResidency) -- and drawn as one point object.
 *
 * The tree's points are ENU metres about the snapshot's own origin (version.json `origin`: lat, lon, h0).
 * The scene has its own frame (an observer's, re-laid out every 20 km), so the object carries
 * rigid(snapshot, scene); the camera goes the other way for the measure, so node choice is exact in the
 * tree's frame wherever the scene's origin is.
 */
import type * as THREE_NS from 'three';
import type { CopcChunk } from './copcSource';
import { CopcSource } from './copcSource';
import { readBlocks } from './copcBlocks';
import { Frame, rigid } from './geodesy';
import type { WorldRequests } from './worldRequests';
import { WorldResidency } from './worldResidency';
import { cameraMeasure, planWorldView, worldBatch } from './worldView';

type Three = typeof THREE_NS;

export type AtlasPointer = { schema: 1; key: string; resolution: 'stored' | 'full'; path: string; built_at: number; points: number };
export type AtlasCredit = { text: string; url: string | null };
export type AtlasVersion = {
	schema: 1; key: string; resolution: 'stored' | 'full'; built_at: number; points: number;
	origin: [number, number, number]; overlap: 'all' | 'nearest';
	licence: { spdx: string; name: string; url: string }; credits: AtlasCredit[]; modified: string;
	runs: { i: number; id: string; name: string | null; points: number; dense_state: string | null }[];
	files: { tree: string; cameras: string };
};
export type Atlas = { pointer: AtlasPointer; version: AtlasVersion; treeUrl: string; camerasUrl: string };

async function json<T>(f: typeof fetch, url: string, signal?: AbortSignal): Promise<T> {
	const r = await f(url, { signal });
	if (!r.ok) throw new Error(`atlas: ${r.status} for ${url}`);
	return (await r.json()) as T;
}

/** A channel's current snapshot: its pointer, its version record and the URLs of its files. */
export async function loadAtlas(base: string, channel: string, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Atlas> {
	const f = opts.fetch ?? fetch;
	const root = base.replace(/\/+$/, '');
	const pointer = await json<AtlasPointer>(f, `${root}/${encodeURIComponent(channel)}.json`, opts.signal);
	if (pointer.schema !== 1 || !/^[0-9a-f]{16}$/.test(pointer.key) || pointer.path !== `w/${pointer.resolution}/${pointer.key}/`)
		throw new Error(`atlas: ${channel}.json is not a schema-1 pointer at its own key`);
	const folder = `${root}/${pointer.path}`;
	const version = await json<AtlasVersion>(f, `${folder}version.json`, opts.signal);
	if (version.schema !== 1 || version.key !== pointer.key || version.resolution !== pointer.resolution)
		throw new Error(`atlas: ${folder}version.json describes another version`);
	if (!Array.isArray(version.origin) || version.origin.length !== 3 || !version.origin.every(Number.isFinite))
		throw new Error(`atlas: ${folder}version.json has no origin`);
	return { pointer, version, treeUrl: `${folder}${version.files.tree}`, camerasUrl: `${folder}${version.files.cameras}` };
}

/** sRGB bytes to linear floats, as three's vertex colours are read (one table, 256 entries) */
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
	const c = i / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export class AtlasCloud {
	readonly object: THREE_NS.Points;
	private source: CopcSource | null = null;
	private residency: WorldResidency;
	private readonly scope: string;
	private readonly abort = new AbortController();
	private wanted: { camera: THREE_NS.PerspectiveCamera; heightPx: number; reversed: boolean } | null = null;
	private running = false;
	private readonly treeCamera: THREE_NS.PerspectiveCamera;
	private disposed = false;
	error: string | null = null;

	constructor(private THREE: Three, private o: {
		treeUrl: string; frame: Frame; scene: Frame; requests: WorldRequests;
		budgetMiB?: number; pointPx?: number; onChange?: () => void;
	}) {
		const bytes = (o.budgetMiB ?? 64) * 1024 * 1024;
		this.residency = new WorldResidency(bytes, bytes);
		this.scope = o.requests.scope('atlas points');
		this.object = new THREE.Points(new THREE.BufferGeometry(),
			new THREE.PointsMaterial({ size: o.pointPx ?? 2, sizeAttenuation: false, vertexColors: true }));
		this.object.matrixAutoUpdate = false;
		this.object.frustumCulled = false;
		this.treeCamera = new THREE.PerspectiveCamera();
		this.setScene(o.scene);
	}

	/** the scene was laid out about another origin: carry the tree there */
	setScene(scene: Frame) {
		this.o.scene = scene;
		this.object.matrix.set(...(rigid(this.o.frame, scene) as Parameters<THREE_NS.Matrix4['set']>));
		this.object.matrixWorldNeedsUpdate = true;
	}

	async open() {
		this.source = await CopcSource.open(this.o.treeUrl, { signal: this.abort.signal, hasCloudTypes: true });
	}

	/** what the camera sees now; the stream follows it, one batch at a time */
	update(camera: THREE_NS.PerspectiveCamera, heightPx: number, reversed: boolean) {
		if (this.disposed || !this.source) return;
		this.wanted = { camera, heightPx, reversed };
		if (!this.running) void this.pump();
	}

	get summary() {
		return this.residency.summary;
	}

	/** no batch to read and no view waiting: what the view can show of this tree, it shows. A full budget
	 * leaves later nodes pending for good (WorldResidency blocks the next), so `pending` cannot say this. */
	get idle() {
		return !this.running && !this.wanted;
	}

	private async pump() {
		const THREE = this.THREE, source = this.source!;
		this.running = true;
		try {
			while (this.wanted && !this.disposed) {
				const { camera, heightPx, reversed } = this.wanted;
				this.wanted = null;
				// the camera, carried into the tree's frame: the measure is exact there
				camera.updateMatrixWorld();
				const toTree = this.object.matrix.clone().invert().multiply(camera.matrixWorld);
				const t = this.treeCamera;
				toTree.decompose(t.position, t.quaternion, new THREE.Vector3());
				t.fov = camera.fov; t.aspect = camera.aspect; t.near = camera.near; t.far = camera.far; t.zoom = camera.zoom;
				// the camera's own projection (reversed-Z included); the tree camera is never rendered to set its own
				t.projectionMatrix.copy(camera.projectionMatrix);
				t.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
				const { measure, nearGroups } = cameraMeasure(THREE, t, [0, 0, 0], heightPx, reversed);
				this.residency.reconcile(planWorldView(source.select({}), measure), 'dense');
				while (!this.wanted && !this.disposed) {
					const batch = worldBatch(this.residency.priorityPoints, true);
					const nodes = this.residency.nextBatch(batch.maxNodes, batch.rawPoints,
						batch.separateNear ? (node) => nearGroups.get(node.key) ?? 0 : () => 0);
					if (!nodes.length) break;
					await readBlocks(source, nodes, {
						url: this.o.treeUrl, requests: this.o.requests, scope: this.scope, signal: this.abort.signal,
						each: async (_index, node, chunk) => { await this.residency.accept(node, chunk); }
					});
					this.rebuild();
					// a failed block is read again by a later batch (residency keeps nothing in flight): recovered
					this.error = null;
					this.o.onChange?.();
				}
			}
		} catch (e) {
			if (!this.disposed) {
				this.error = e instanceof Error ? e.message : String(e);
				this.o.onChange?.();
			}
		} finally {
			this.running = false;
		}
	}

	private rebuild() {
		const THREE = this.THREE;
		const blocks: CopcChunk[] = this.residency.blocks;
		const n = blocks.reduce((a, b) => a + b.positions.length / 3, 0);
		const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
		let k = 0;
		for (const b of blocks) {
			pos.set(b.positions, k);
			for (let i = 0; i < b.colors.length; i++) col[k + i] = LINEAR[b.colors[i]];
			k += b.positions.length;
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		g.setAttribute('color', new THREE.BufferAttribute(col, 3));
		this.object.geometry.dispose();
		this.object.geometry = g;
	}

	dispose() {
		this.disposed = true;
		this.abort.abort();
		this.o.requests.release(this.scope, 'atlas closed');
		this.source?.dispose();
		this.object.geometry.dispose();
		(this.object.material as THREE_NS.Material).dispose();
	}
}
