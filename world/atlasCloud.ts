/**
 * The public atlas in a scene: published world snapshots read from their static files. A world is one town's;
 * <channel>.towns.json names one version per town, and w/<resolution>/<key>/ holds each version's version.json
 * and COPC tree. Each is streamed as the workbench streams it -- planned by what the camera sees (cameraMeasure,
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
import type { Credit } from './earth';
import { readBlocks } from './copcBlocks';
import { BlockCloud, srgbPointsMaterial } from './blockCloud';
import { Frame, rigid } from './geodesy';
import type { WorldRequests } from './worldRequests';
import { WorldResidency } from './worldResidency';
import { cameraMeasure, planWorldView, worldBatch } from './worldView';

type Three = typeof THREE_NS;

export type AtlasTown = { id: string; label: string };
/** one town's entry in a channel's pointer */
export type AtlasEntry = { town: AtlasTown; key: string; resolution: 'stored' | 'full'; path: string; built_at: number; points: number };
export type AtlasTowns = { schema: 2; towns: AtlasEntry[] };
export type AtlasCredit = { text: string; url: string | null };
export type AtlasVersion = {
	schema: 2; key: string; resolution: 'stored' | 'full'; built_at: number; points: number; town: AtlasTown;
	origin: [number, number, number]; overlap: 'all' | 'nearest' | 'drawn' | 'drawn_once';
	licence: { spdx: string; name: string; url: string }; credits: AtlasCredit[]; modified: string;
	runs: { i: number; id: string; name: string | null; points: number; dense_state: string | null }[];
	files: { tree: string; cameras: string };
};
export type Atlas = { entry: AtlasEntry; version: AtlasVersion; treeUrl: string; camerasUrl: string };

async function json<T>(f: typeof fetch, url: string, signal?: AbortSignal): Promise<T> {
	const r = await f(url, { signal });
	if (!r.ok) throw new Error(`atlas: ${r.status} for ${url}`);
	return (await r.json()) as T;
}

const root = (base: string) => base.replace(/\/+$/, '');

/** A channel's pointer: one version per town (what a version picker labels). */
export async function loadTowns(base: string, channel: string, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}):
	Promise<AtlasTowns> {
	const name = `${encodeURIComponent(channel)}.towns.json`;
	const pointer = await json<AtlasTowns>(opts.fetch ?? fetch, `${root(base)}/${name}`, opts.signal);
	if (pointer.schema !== 2 || !Array.isArray(pointer.towns) || pointer.towns.length === 0)
		throw new Error(`atlas: ${name} is not a schema-2 pointer naming at least one town`);
	const seen = new Set<string>();
	for (const e of pointer.towns) {
		if (!e.town || typeof e.town.id !== 'string' || !e.town.label || !/^[0-9a-f]{16}$/.test(e.key)
			|| e.path !== `w/${e.resolution}/${e.key}/`)
			throw new Error(`atlas: ${name} names a town without its id and label, or a version not at its own key`);
		if (seen.has(e.town.id)) throw new Error(`atlas: ${name} names ${e.town.label} twice`);
		seen.add(e.town.id);
	}
	return pointer;
}

/** A channel's current snapshots, one per town: each one's entry, version record and the URLs of its files. */
export async function loadAtlases(base: string, channel: string, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Atlas[]> {
	const f = opts.fetch ?? fetch;
	const pointer = await loadTowns(base, channel, opts);
	return Promise.all(pointer.towns.map(async (entry) => {
		const folder = `${root(base)}/${entry.path}`;
		const version = await json<AtlasVersion>(f, `${folder}version.json`, opts.signal);
		if (version.schema !== 2 || version.key !== entry.key || version.resolution !== entry.resolution
			|| version.town?.id !== entry.town.id)
			throw new Error(`atlas: ${folder}version.json describes another version than ${entry.town.label}'s`);
		if (!Array.isArray(version.origin) || version.origin.length !== 3 || !version.origin.every(Number.isFinite))
			throw new Error(`atlas: ${folder}version.json has no origin`);
		return { entry, version, treeUrl: `${folder}${version.files.tree}`, camerasUrl: `${folder}${version.files.cameras}` };
	}));
}

const page = (url: string) => url.replace(/\/+$/, '');

/** the credit line of a scene drawing these snapshots over earth's layers: earth's sources, then per snapshot its
 * licence and its own credits less the sources earth already names (one source page, one credit: ČÚZK's and
 * Copernicus' terrain, which placed the snapshot and draws the ground), each line once whichever towns share it.
 * Each export's README keeps its full list. */
export function atlasCredits(earth: Credit[], versions: AtlasVersion[]): Credit[] {
	const shown = new Set(earth.map((c) => page(c.url)));
	const out: Credit[] = [...earth];
	const said = new Set<string>();
	const add = (c: Credit) => {
		const k = `${c.text}\u0000${c.url}`;
		if (!said.has(k)) { said.add(k); out.push(c); }
	};
	for (const v of versions) {
		add({ text: `Point cloud: ${v.licence.name}`, url: v.licence.url, licence: v.licence.spdx });
		for (const c of v.credits.filter((c) => c.url === null || !shown.has(page(c.url))))
			add({ text: c.text, url: c.url ?? v.licence.url, licence: v.licence.spdx });
	}
	return out;
}

export class AtlasCloud {
	/** the held blocks, each its own Points (BlockCloud); the group's matrix carries the tree into the scene */
	readonly object: THREE_NS.Group;
	private readonly blocks: BlockCloud;
	private readonly material: THREE_NS.PointsMaterial;
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
		// EACH BLOCK UPLOADED ONCE (ea14 A-1): the cloud was concatenated into one new geometry and uploaded whole after
		// every batch, which froze the workbench's world viewer at large budgets; the app's atlas did the same
		this.material = srgbPointsMaterial(THREE, { size: o.pointPx ?? 2, sizeAttenuation: false });
		this.blocks = new BlockCloud(THREE, { material: this.material });
		this.object = this.blocks.object;
		this.object.matrixAutoUpdate = false;
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

	private groundMemo: { at: string; h: number | null; t: number } = { at: '', h: null, t: 0 };
	/**
	 * The ground under a point as the resident points say it, for a scene without terrain (earth unreachable): the
	 * 10th percentile of their heights within 15 m, else 60 m (in a photogrammetric cloud the low points are the
	 * ground; roofs and trees stand above it); null with fewer than 30 there. Ellipsoidal metres. A height found is
	 * kept for its point; while none is, the scan (every resident point) runs at most every 500 ms as blocks arrive.
	 */
	groundAt(lat: number, lon: number): number | null {
		const at = `${lat},${lon}`, now = performance.now();
		if (at === this.groundMemo.at && (this.groundMemo.h !== null || now - this.groundMemo.t < 500)) return this.groundMemo.h;
		const blocks: CopcChunk[] = this.residency.blocks;
		const [px, py] = this.o.frame.fromGeodetic(lat, lon, 0);
		let h: number | null = null;
		for (const r of [15, 60]) {
			const zs: number[] = [];
			for (const b of blocks) {
				const p = b.positions;
				for (let i = 0; i < p.length; i += 3) {
					const dx = p[i] - px, dy = p[i + 1] - py;
					if (dx * dx + dy * dy <= r * r) zs.push(p[i + 2]);
				}
			}
			if (zs.length >= 30) {
				zs.sort((a, b) => a - b);
				h = this.o.frame.toGeodetic(px, py, zs[Math.floor(zs.length * 0.1)])[2];
				break;
			}
		}
		this.groundMemo = { at, h, t: now };
		return h;
	}

	/** no batch to read and no view waiting: what the view can show of this tree, it shows. A full budget
	 * leaves later nodes pending for good (WorldResidency blocks the next), so `pending` cannot say this. */
	get idle() {
		return !this.running && !this.wanted && !this.blocks.waitingBlocks;
	}

	/** Before each render: held blocks that wait join the drawn ones, up to a frame's upload (BlockCloud.step); while
	 * more wait, another frame is asked for (onChange), so a scene drawn on demand finishes them. */
	beforeRender() {
		if (this.blocks.step()) this.o.onChange?.();
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
				// a plan may let blocks go (a new mode clears the residency): they leave the drawn set at once
				this.blocks.sync(this.residency.blocks);
				while (!this.wanted && !this.disposed) {
					const batch = worldBatch(this.residency.priorityPoints, true);
					const nodes = this.residency.nextBatch(batch.maxNodes, batch.rawPoints,
						batch.separateNear ? (node) => nearGroups.get(node.key) ?? 0 : () => 0);
					if (!nodes.length) break;
					await readBlocks(source, nodes, {
						url: this.o.treeUrl, requests: this.o.requests, scope: this.scope, signal: this.abort.signal,
						each: async (_index, node, chunk) => { await this.residency.accept(node, chunk); }
					});
					this.blocks.sync(this.residency.blocks);
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

	dispose() {
		this.disposed = true;
		this.abort.abort();
		this.o.requests.release(this.scope, 'atlas closed');
		this.source?.dispose();
		this.blocks.dispose();
		this.material.dispose();
	}
}
