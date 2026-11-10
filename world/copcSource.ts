import { CopcChunkCache } from './copcCache';
import { responseOrThrow, type ResourceRead } from './worldRequests';
/**
 * A COPC dense cloud, read over HTTP range requests.
 *
 * WHY THIS EXISTS: cloud.bin makes the server choose ONE density for the whole scene, so
 * the viewer was shown 450 k of a run's 14 M points and every diagnostic -- the section,
 * the isolated camera, the band around one frame -- was cutting into an already-thinned
 * cloud. Asking for more was not an option either: the cap is there because a flat array
 * has to be sent whole.
 *
 * COPC stores the points as an OCTREE, which splits that single decision in two:
 *   - how coarse: which octree LEVELS to load (level 0 alone is an instant overview)
 *   - where:      which NODES overlap the box you care about
 * They are independent, so a 4 m section can be loaded at FULL density while the rest of
 * the scene stays at level 0 -- measured on run 8b696c73 over HTTP: the file opens in
 * 0.03 s reading only its header, the overview is 11 k points, and a 4 m box at full
 * density is 309 k points in 0.28 s, out of 1.65 M.
 *
 * THE FRAME IS THE SOLVE'S. The server sends the ENU similarity in X-Enu-Alignment rather
 * than baking it in (see the cloud.copc.laz endpoint); `enu` below carries it so the caller
 * can apply it as one object transform instead of touching every point.
 *
 * PER-POINT CAMERA: copc_build.py ferries the PLY's `view` into LAS's PointSourceId, so
 * "isolate one camera" survives the format. Runs solved before 2026-09-14 have no view
 * dimension and `views` comes back null.
 */
import { Copc, Getter, type Hierarchy } from 'copc';
import { CopcDecoder } from './copcDecoder';
import { readCopcRange } from './copcRange';

export type { EnuAlignment, Slab } from './copcGeom';
import { type EnuAlignment, type Slab, overlaps, slabHitsBox, slabInFileFrame } from './copcGeom';
export { slabInFileFrame };

export type CopcNode = {
	key: string;
	depth: number;
	pointCount: number;
	/** [minx, miny, minz, maxx, maxy, maxz] in solve metres */
	bounds: [number, number, number, number, number, number];
	/** take every n-th point of this node; set only when the node alone exceeds the budget */
	stride?: number;
};

export type CopcChunk = {
	positions: Float32Array; // xyz triples, solve metres
	colors: Uint8Array; // rgb triples, 0-255
	views: Uint16Array | null; // per-point camera index, or null when the run has none
	cloudTypes?: Uint8Array | null; // world UserData: 1 stored dense, 2 sparse
	linear?: Float32Array; // rgb triples, linear 0-1: set by a WorldPlacement that draws them (then positions are placed)
};

/**
 * The nominal distance between neighbouring points at `depth` of a COPC octree, in metres. The COPC info's `spacing`
 * is the root's, in the file's units, and each level halves it. `toMetres` is how many metres one file unit is: 1 for
 * a tree written in metres (the world's), the ENU alignment's scale for a run's tree in solve units. A nominal figure:
 * a sparse node holds its points further apart. Bad input throws: a spacing that reads as "0 cm" would be a wrong
 * answer, not a missing one.
 */
export function levelSpacing(rootSpacing: number, toMetres: number, depth: number): number {
	if (!(Number.isFinite(rootSpacing) && rootSpacing > 0)) throw new Error(`COPC spacing must be positive, got ${rootSpacing}`);
	if (!(Number.isFinite(toMetres) && toMetres > 0)) throw new Error(`COPC unit scale must be positive, got ${toMetres}`);
	if (!(Number.isSafeInteger(depth) && depth >= 0)) throw new Error(`COPC depth must be a level, got ${depth}`);
	return (rootSpacing * toMetres) / 2 ** depth;
}

export class CopcSource {
	private constructor(
		readonly url: string,
		private readonly copc: Copc,
		private readonly getter: Getter,
		private readonly nodes: CopcNode[],
		private readonly rawNodes: Hierarchy.Node.Map,
		readonly enu: EnuAlignment | null,
		readonly pointCount: number,
		readonly hasViews: boolean,
		readonly hasCloudTypes: boolean
	) {}

	static async open(url: string, options: {signal?: AbortSignal; read?: ResourceRead; hasCloudTypes: boolean}): Promise<CopcSource> {
		const {signal,read,hasCloudTypes}=options;
		// One tiny ranged probe for the run-level headers, then copc's own ranged reads.
		// The alignment is metadata about the RUN, not about the file, which is why it
		// travels as a header rather than baked into the LAS.
		let enu: EnuAlignment | null = null;
		let hasViews = false;
		const reader: ResourceRead = read ?? (async (url, init, consume) => consume(await fetch(url, init)));
		const probe: { response?: Response } = {};
		await readCopcRange((u, init, consume) => reader(u, init, async response => {
			probe.response = response;
			return consume(response);
		}), url, 0, 1, signal);
		if (!probe.response) throw new Error('COPC metadata probe returned no response');
		const raw = probe.response.headers.get('x-enu-alignment');
		if (raw) enu = JSON.parse(raw);
		// PointSourceId exists even without per-camera data; the API checks the source PLY.
		// Worlds use the same native field for immutable solve indices. They
		// always have it, independently of a run's optional camera-view header.
		hasViews = hasCloudTypes || probe.response.headers.get('x-has-view') === '1';
		const getter: Getter = (begin, end) => readCopcRange(reader, url, begin, end, signal);
		const copc = await Copc.create(getter);
		const nodes: Hierarchy.Node.Map = {};
		const pending = [copc.info.rootHierarchyPage];
		const visited = new Set<number>();
		// Large files split the hierarchy into pages. Full density requires all of them.
		while (pending.length) {
			const page = pending.pop()!;
			if (visited.has(page.pageOffset)) continue;
			visited.add(page.pageOffset);
			const subtree = await Copc.loadHierarchyPage(getter, page);
			Object.assign(nodes, subtree.nodes);
			for (const child of Object.values(subtree.pages)) if (child) pending.push(child);
		}

		const cube = copc.info.cube; // [minx,miny,minz,maxx,maxy,maxz] of the octree root
		const out: CopcNode[] = [];
		let total = 0;
		for (const [key, node] of Object.entries(nodes)) {
			if (!node || node.pointCount === 0) continue;
			const [d, x, y, z] = key.split('-').map(Number);
			const span = 2 ** d;
			const sx = (cube[3] - cube[0]) / span;
			const sy = (cube[4] - cube[1]) / span;
			const sz = (cube[5] - cube[2]) / span;
			out.push({
				key,
				depth: d,
				pointCount: node.pointCount,
				bounds: [
					cube[0] + x * sx,
					cube[1] + y * sy,
					cube[2] + z * sz,
					cube[0] + (x + 1) * sx,
					cube[1] + (y + 1) * sy,
					cube[2] + (z + 1) * sz
				]
			});
			total += node.pointCount;
		}
		out.sort((a, b) => a.depth - b.depth);
		signal?.throwIfAborted();
		return new CopcSource(url, copc, getter, out, nodes, enu, total, hasViews,
			hasCloudTypes);
	}

	/**
	 * The nodes to draw, cheapest first.
	 *
	 * `maxDepth` is the density control and `bounds` the extent control, and they compose:
	 * the overview is maxDepth 0 over everything, a full-density section is no maxDepth over
	 * a thin box. Nothing is fetched here — this only decides what to fetch.
	 */
	/** How many nodes the hierarchy holds in total — the denominator for what a selection took. */
	get nodeCount(): number {
		return this.nodes.length;
	}

	/** The deepest level any node of the hierarchy sits at; the root is 0 (the nodes are sorted by depth). Not select()'s
	 * `maxDepth` option, which caps a selection. */
	get deepestLevel(): number {
		return this.nodes.length ? this.nodes[this.nodes.length - 1].depth : 0;
	}

	/** The nominal distance between neighbouring points at `depth`, in metres (levelSpacing over the COPC info's spacing,
	 * in metres through the ENU alignment's scale when the tree has one). What a viewer can say about how fine the detail
	 * it loaded is (recon/directions ui06: the operator asked for points and metres). */
	spacingAt(depth: number): number {
		return levelSpacing(this.copc.info.spacing, this.enu?.scale ?? 1, depth);
	}

	/**
	 * `keep` is an arbitrary test on a node's file-frame box, for callers whose region of
	 * interest is not expressible here: the viewer's is the camera's view, and getting there
	 * means undoing the ENU alignment AND the operator's placement, both of which live in the
	 * viewer and neither of which this file knows about. It tests the node's BOX, so a caller
	 * that is conservative (keep a node whose box touches the region at all) cannot drop a point
	 * that should have been drawn -- which is the failure worth avoiding, because it shows up as
	 * a hole in the cloud rather than as an error. It gets the whole node, DEPTH INCLUDED, so a
	 * caller can keep the coarse levels unconditionally and have its region buy depth rather
	 * than coverage.
	 */
	select(opts: {
		maxDepth?: number; bounds?: number[]; slab?: Slab; budget?: number;
		keep?: (node: CopcNode) => boolean;
	} = {}): CopcNode[] {
		const { maxDepth = Infinity, bounds, slab, budget = Infinity, keep } = opts;
		const avail = this.nodes.filter(
			(n) =>
				n.depth <= maxDepth &&
				(!bounds || overlaps(n.bounds, bounds)) &&
				(!slab || slabHitsBox(slab, n.bounds)) &&
				(!keep || keep(n))
		);
		const picked: CopcNode[] = [];
		let n = 0;
		// Whole levels while they fit. A level is a uniform subdivision of the cube, so taking
		// all of one is spatially even everywhere.
		const byDepth = new Map<number, CopcNode[]>();
		for (const node of avail) (byDepth.get(node.depth) ?? byDepth.set(node.depth, []).get(node.depth)!).push(node);
		const depths = [...byDepth.keys()].sort((a, b) => a - b);
		for (const d of depths) {
			const level = byDepth.get(d)!;
			const cost = level.reduce((a, x) => a + x.pointCount, 0);
			if (n + cost <= budget) {
				picked.push(...level);
				n += cost;
				continue;
			}
			// THE PARTIAL LEVEL IS WHERE NAIVE TRUNCATION GOES WRONG. Stopping at the first node
			// that does not fit takes a contiguous run of the level and leaves the rest of the
			// scene at the coarser depth -- one half of the walk detailed and the other not,
			// which moved the auto-framing 5 m against cloud.bin's evenly strided cloud. Taking
			// every k-th node instead spreads the same budget over the whole extent, which is
			// what the flat cloud's even stride does and what the eye expects.
			const room = budget - n;
			const avg = cost / level.length;
			const canTake = Math.max(0, Math.floor(room / Math.max(avg, 1)));
			if (canTake > 0) {
				const step = level.length / canTake;
				for (let i = 0; i < canTake; i++) {
					const node = level[Math.min(level.length - 1, Math.floor(i * step))];
					if (n + node.pointCount > budget) break;
					picked.push(node);
					n += node.pointCount;
				}
			} else if (room > 0) {
				// NO WHOLE NODE OF THIS LEVEL FITS, WHICH IS NOT A REASON TO SHOW NOTHING. Taking
				// zero here was a silent, total failure: on the merged atlas the whole of
				// spotA46-depthadd-clamped-rep3 is ONE node of 2,000,000 points -- a 40 m capture
				// against a 17 km octree cube, so the writer never subdivided it -- and flying to
				// it drew 858 points, the overview, while 2,000,599 sat inside the view. The
				// picture said "there is nothing here" and the readout agreed.
				// So thin the level PER POINT instead of per node. It costs the whole level's
				// bytes, which is why it is the fallback and not the rule, but the alternative is
				// an empty screen over a place that is fully reconstructed.
				const stride = Math.max(2, Math.ceil(cost / room));
				for (const node of level) picked.push({ ...node, stride });
				n = budget;
			}
			break; // anything deeper would be sparser still
		}
		return picked;
	}

	get bounds(): [number,number,number,number,number,number] {
		return [...this.copc.header.min,...this.copc.header.max];
	}

	/** Decompress one node into the packed arrays the viewer's geometry wants. */
	async load(node: CopcNode, signal?: AbortSignal): Promise<CopcChunk> {
		signal?.throwIfAborted();
		if (this.closed) throw new DOMException('COPC source closed', 'AbortError');
		const key = `${node.key}|${node.stride ?? 1}`;
		const cached = this.cache.get(key);
		if (cached) return cached;
		// the hierarchy is read once in open() and kept: re-walking it per node turned one
		// ranged read into two, for a page that never changes
		const raw = this.rawNodes[node.key];
		if (!raw) throw new Error(`no such copc node: ${node.key}`);
		const getter: Getter = signal ? (begin, end) => readCopcRange(
            async (url, init, consume) => consume(await responseOrThrow(url, signal, init)),
            this.url, begin, end, signal) : this.getter;
		const compressed = await Copc.loadCompressedPointDataBuffer(getter, raw);
		signal?.throwIfAborted();
		const chunk = await this.decoder.decode({ compressed, header: this.copc.header, eb: this.copc.eb,
			pointCount: raw.pointCount, stride: node.stride, hasViews: this.hasViews, hasCloudTypes: this.hasCloudTypes }, signal);
		signal?.throwIfAborted();
		if (this.closed) throw new DOMException('COPC source closed', 'AbortError');
		this.cache.set(key, chunk);
		return chunk;
	}

	private readonly decoder = new CopcDecoder();
	private readonly cache = new CopcChunkCache();
	private closed = false;

	/** Stop the decoder and reject unfinished jobs when the source leaves the viewer. */
	dispose() { this.closed = true; this.decoder.dispose(); this.cache.clear(); }

	/** Every node's point count by depth — what a density slider should be labelled with. */
	depthHistogram(): { depth: number; nodes: number; points: number }[] {
		const by = new Map<number, { depth: number; nodes: number; points: number }>();
		for (const n of this.nodes) {
			const e = by.get(n.depth) ?? { depth: n.depth, nodes: 0, points: 0 };
			e.nodes++;
			e.points += n.pointCount;
			by.set(n.depth, e);
		}
		return [...by.values()].sort((a, b) => a.depth - b.depth);
	}
}
