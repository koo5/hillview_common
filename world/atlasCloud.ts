/**
 * The public atlas in a scene: published world snapshots read from their static files. A world is one town's;
 * <channel>.towns.json names one version per town, and w/<resolution>/<key>/ holds each version's version.json
 * and COPC tree. They are streamed as the workbench streams one -- planned by what the camera sees (cameraMeasure,
 * rankWorldView, the towns' plans merged by mergeWorldPlans), read in batches through the request scheduler
 * (readBlocks), held within ONE budget (WorldResidency) -- and drawn as one group, a point object per town.
 *
 * A tree's points are ENU metres about its snapshot's own origin (version.json `origin`: lat, lon, h0).
 * The scene has its own frame (an observer's, re-laid out every 20 km), so each town's object carries
 * rigid(snapshot, scene); the camera goes the other way for the measure, so node choice is exact in each
 * tree's frame wherever the scene's origin is.
 */
import type * as THREE_NS from 'three';
import type { CopcChunk, CopcNode } from './copcSource';
import { CopcSource } from './copcSource';
import type { Credit } from './earth';
import { readBlocks } from './copcBlocks';
import { BLOCK_UPLOAD_BYTES, BlockCloud, srgbPointsMaterial } from './blockCloud';
import { initialPointSizing, sizeByDistance, type PointSizing } from './pointSizing';
import { Frame, rigid } from './geodesy';
import type { WorldRequests } from './worldRequests';
import { WorldResidency } from './worldResidency';
import { cameraMeasure, mergeWorldPlans, rankWorldView, worldBatch } from './worldView';

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

/** A channel's current snapshots, one per town: each one's entry, version record and the URLs of its files. Each
 * town loads on its own: one whose version cannot be read is in `failed`, with why, and the rest load. Throws when
 * the pointer cannot be read. */
export async function loadAtlases(base: string, channel: string, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}):
	Promise<{ loaded: Atlas[]; failed: { entry: AtlasEntry; error: string }[] }> {
	const f = opts.fetch ?? fetch;
	const pointer = await loadTowns(base, channel, opts);
	const got = await Promise.allSettled(pointer.towns.map(async (entry): Promise<Atlas> => {
		const folder = `${root(base)}/${entry.path}`;
		const version = await json<AtlasVersion>(f, `${folder}version.json`, opts.signal);
		if (version.schema !== 2 || version.key !== entry.key || version.resolution !== entry.resolution
			|| version.town?.id !== entry.town.id)
			throw new Error(`atlas: ${folder}version.json describes another version than ${entry.town.label}'s`);
		if (!Array.isArray(version.origin) || version.origin.length !== 3 || !version.origin.every(Number.isFinite))
			throw new Error(`atlas: ${folder}version.json has no origin`);
		return { entry, version, treeUrl: `${folder}${version.files.tree}`, camerasUrl: `${folder}${version.files.cameras}` };
	}));
	const loaded: Atlas[] = [], failed: { entry: AtlasEntry; error: string }[] = [];
	got.forEach((r, i) => {
		if (r.status === 'fulfilled') loaded.push(r.value);
		else failed.push({ entry: pointer.towns[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
	});
	return { loaded, failed };
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

/** one town in an AtlasCloud: where its tree is and the frame its points are in (its version's origin) */
export type AtlasCloudTown = { label: string; treeUrl: string; frame: Frame };

type Town = AtlasCloudTown & {
	index: number;
	/** this town's held blocks, drawn under its own matrix rigid(town frame, scene) */
	blocks: BlockCloud;
	source: CopcSource | null;
	error: string | null;
	camera: THREE_NS.PerspectiveCamera;
};

/** a node of one town as the shared residency holds it: the town's index before its own key, so keys never meet */
const heldKey = (town: number, key: string) => `${town}/${key}`;

/**
 * Every town a channel names, drawn from ONE budget (aw12 B). Each town's tree is planned by what the camera sees in
 * that tree's own frame (the camera carried into it, as for one tree); the towns' plans are merged into one ranking
 * (mergeWorldPlans: in view first, then nearer, then coarser, in metres from the same camera), and one WorldResidency
 * holds the blocks of every town under the one budget. So a close look at one town gets the whole budget there, and a
 * town out of view gives its room up as any retained block does. Each town has its own BlockCloud under its own
 * matrix; the frame's GPU upload cap is shared between them. A town whose tree cannot be opened is left out and said
 * (`error`); the others draw.
 */
export class AtlasCloud {
	/** a group of one group per town; each town's matrix carries its tree into the scene */
	readonly object: THREE_NS.Group;
	private readonly towns: Town[];
	private readonly material: THREE_NS.PointsMaterial;
	private readonly residency: WorldResidency;
	/** the current plan's nodes, by held key: which town, and its own node */
	private held = new Map<string, { town: Town; node: CopcNode }>();
	private readonly scope: string;
	private readonly abort = new AbortController();
	private wanted: { camera: THREE_NS.PerspectiveCamera; heightPx: number; reversed: boolean } | null = null;
	private running = false;
	private disposed = false;
	private pumpError: string | null = null;

	/** every town's points sized by `sizing`: the one material's uniforms, nothing read or uploaded again */
	setPointSizing(sizing: PointSizing) {
		sizeByDistance(this.material, sizing);
	}

	constructor(private THREE: Three, private o: {
		towns: AtlasCloudTown[]; scene: Frame; requests: WorldRequests;
		budgetMiB?: number;
		/** each point's size by its distance (pointSizing.ts); initialPointSizing() unless given */
		sizing?: PointSizing; onChange?: () => void;
	}) {
		if (!o.towns.length) throw new Error('an atlas cloud draws at least one town');
		const bytes = (o.budgetMiB ?? 64) * 1024 * 1024;
		this.residency = new WorldResidency(bytes, bytes);
		this.scope = o.requests.scope('atlas points');
		// EACH BLOCK UPLOADED ONCE (ea14 A-1); the frame's upload cap is the towns' together
		this.material = srgbPointsMaterial(THREE);
		sizeByDistance(this.material, o.sizing ?? initialPointSizing());
		this.object = new THREE.Group();
		const uploadBytes = Math.floor(BLOCK_UPLOAD_BYTES / o.towns.length);
		this.towns = o.towns.map((t, index) => {
			const blocks = new BlockCloud(THREE, { material: this.material, uploadBytes });
			blocks.object.matrixAutoUpdate = false;
			this.object.add(blocks.object);
			return { ...t, index, blocks, source: null, error: null, camera: new THREE.PerspectiveCamera() };
		});
		this.setScene(o.scene);
	}

	/** the scene was laid out about another origin: carry every town's tree there */
	setScene(scene: Frame) {
		this.o.scene = scene;
		for (const t of this.towns) {
			t.blocks.object.matrix.set(...(rigid(t.frame, scene) as Parameters<THREE_NS.Matrix4['set']>));
			t.blocks.object.matrixWorldNeedsUpdate = true;
		}
	}

	/** opens every town's tree, each on its own: one that fails is said and left out; throws only when none opens */
	async open() {
		const opened = await Promise.allSettled(this.towns.map((t) =>
			CopcSource.open(t.treeUrl, { signal: this.abort.signal, hasCloudTypes: true })));
		opened.forEach((r, i) => {
			if (r.status === 'fulfilled') this.towns[i].source = r.value;
			else this.towns[i].error = `${this.towns[i].label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
		});
		if (this.towns.every((t) => !t.source)) throw new Error(this.towns.map((t) => t.error).join('; '));
	}

	/** what the camera sees now; the stream follows it, one batch at a time */
	update(camera: THREE_NS.PerspectiveCamera, heightPx: number, reversed: boolean) {
		if (this.disposed || this.towns.every((t) => !t.source)) return;
		this.wanted = { camera, heightPx, reversed };
		if (!this.running) void this.pump();
	}

	get summary() {
		return this.residency.summary;
	}

	/** the towns whose trees opened, by their index in `towns` (what is drawn, so whose credits apply) */
	get openTowns(): number[] {
		return this.towns.filter((t) => t.source).map((t) => t.index);
	}

	/** a town that did not open, then the stream's own failure; null when all is well */
	get error(): string | null {
		const parts = [...this.towns.map((t) => t.error), this.pumpError].filter((e): e is string => e !== null);
		return parts.length ? parts.join('; ') : null;
	}

	/** each town's held blocks, in the residency's order */
	private blocksOf(): Map<Town, CopcChunk[]> {
		const out = new Map<Town, CopcChunk[]>(this.towns.map((t) => [t, []]));
		const nodes = this.residency.resident, chunks = this.residency.blocks;
		nodes.forEach((n, i) => {
			const town = this.towns[Number(n.key.slice(0, n.key.indexOf('/')))];
			out.get(town)!.push(chunks[i]);
		});
		return out;
	}

	private sync() {
		for (const [town, chunks] of this.blocksOf()) town.blocks.sync(chunks);
	}

	private groundMemo: { at: string; h: number | null; t: number } = { at: '', h: null, t: 0 };
	/**
	 * The ground under a point as the resident points say it, for a scene without terrain (earth unreachable): the
	 * 10th percentile of their heights within 15 m, else 60 m (in a photogrammetric cloud the low points are the
	 * ground; roofs and trees stand above it); null with fewer than 30 there. Each town's points are read in its own
	 * frame, the first town with enough points there answers. Ellipsoidal metres. A height found is kept for its point;
	 * while none is, the scan (every resident point) runs at most every 500 ms as blocks arrive.
	 */
	groundAt(lat: number, lon: number): number | null {
		const at = `${lat},${lon}`, now = performance.now();
		if (at === this.groundMemo.at && (this.groundMemo.h !== null || now - this.groundMemo.t < 500)) return this.groundMemo.h;
		let h: number | null = null;
		for (const [town, blocks] of this.blocksOf()) {
			const [px, py] = town.frame.fromGeodetic(lat, lon, 0);
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
					h = town.frame.toGeodetic(px, py, zs[Math.floor(zs.length * 0.1)])[2];
					break;
				}
			}
			if (h !== null) break;
		}
		this.groundMemo = { at, h, t: now };
		return h;
	}

	/** no batch to read and no view waiting: what the view can show of these trees, it shows. A full budget
	 * leaves later nodes pending for good (WorldResidency blocks the next), so `pending` cannot say this. */
	get idle() {
		return !this.running && !this.wanted && this.towns.every((t) => !t.blocks.waitingBlocks);
	}

	/** Before each render: held blocks that wait join the drawn ones, up to a frame's upload (BlockCloud.step); while
	 * more wait, another frame is asked for (onChange), so a scene drawn on demand finishes them. */
	beforeRender() {
		let more = false;
		for (const t of this.towns) if (t.blocks.step()) more = true;
		if (more) this.o.onChange?.();
	}

	/** one plan over every open town: each tree measured with the camera carried into its frame, the plans merged */
	private plan(camera: THREE_NS.PerspectiveCamera, heightPx: number, reversed: boolean) {
		const THREE = this.THREE;
		camera.updateMatrixWorld();
		const near = new Map<string, number>();
		const plans = this.towns.filter((t) => t.source).map((town) => {
			const toTree = town.blocks.object.matrix.clone().invert().multiply(camera.matrixWorld);
			const t = town.camera;
			toTree.decompose(t.position, t.quaternion, new THREE.Vector3());
			t.fov = camera.fov; t.aspect = camera.aspect; t.near = camera.near; t.far = camera.far; t.zoom = camera.zoom;
			// the camera's own projection (reversed-Z included); the tree camera is never rendered to set its own
			t.projectionMatrix.copy(camera.projectionMatrix);
			t.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
			const { measure, nearGroups } = cameraMeasure(THREE, t, [0, 0, 0], heightPx, reversed);
			const ranked = rankWorldView(town.source!.select({}), measure);
			for (const r of ranked) near.set(heldKey(town.index, r.node.key), nearGroups.get(r.node.key) ?? 0);
			return { ranked, tag: town };
		});
		const merged = mergeWorldPlans(plans);
		this.held = new Map(merged.map(({ node, tag }) => [heldKey(tag.index, node.key), { town: tag, node }]));
		return { nodes: merged.map(({ node, tag }) => ({ ...node, key: heldKey(tag.index, node.key) })), near };
	}

	private async pump() {
		this.running = true;
		try {
			while (this.wanted && !this.disposed) {
				const { camera, heightPx, reversed } = this.wanted;
				this.wanted = null;
				const { nodes: planned, near } = this.plan(camera, heightPx, reversed);
				this.residency.reconcile(planned, 'dense');
				// a plan may let blocks go (a new mode clears the residency): they leave the drawn set at once
				this.sync();
				while (!this.wanted && !this.disposed) {
					const batch = worldBatch(this.residency.priorityPoints, true);
					// a batch reads one tree: the town is part of every group
					const nodes = this.residency.nextBatch(batch.maxNodes, batch.rawPoints, (node) => {
						const town = this.held.get(node.key)!.town.index;
						return batch.separateNear ? `${town}:${near.get(node.key) ?? 0}` : `${town}`;
					});
					if (!nodes.length) break;
					const town = this.held.get(nodes[0].key)!.town;
					await readBlocks(town.source!, nodes.map((n) => this.held.get(n.key)!.node), {
						url: town.treeUrl, requests: this.o.requests, scope: this.scope, signal: this.abort.signal,
						each: async (index, _node, chunk) => { await this.residency.accept(nodes[index], chunk); }
					});
					this.sync();
					// a failed block is read again by a later batch (residency keeps nothing in flight): recovered
					this.pumpError = null;
					this.o.onChange?.();
				}
			}
		} catch (e) {
			if (!this.disposed) {
				this.pumpError = e instanceof Error ? e.message : String(e);
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
		for (const t of this.towns) {
			t.source?.dispose();
			t.blocks.dispose();
		}
		this.material.dispose();
	}
}
