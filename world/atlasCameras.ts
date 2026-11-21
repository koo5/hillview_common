/**
 * An atlas's cameras in the scene: each open town's published cameras.json (its version's `files.cameras`: every
 * photograph's pose in that world) drawn as one CameraFrusta, each solve in a colour of its own. The cones stand under
 * the same matrix as the town's points, rigid(its version's frame, the scene's), so a camera stands where it was
 * solved among the points it drew, and a re-layout of the scene moves them with the points. Read only while shown.
 */
import type * as THREE_NS from 'three';
import { rigid, type Frame } from './geodesy';
import { CameraFrusta, solveTint, type Cone, type Rot, type Vec3 } from './cameraFrusta';
import { responseOrThrow, type WorldRequests } from './worldRequests';

type Three = typeof THREE_NS;

/** one town: where its cameras.json is, and the frame its poses are in (its version's origin) */
export type AtlasCamerasTown = { label: string; camerasUrl: string; frame: Frame };

/** the image plane's distance from each camera, metres */
export const CAMERA_DEPTH_M = 1;

const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * One town's cameras.json as cones. A camera's image is `solver_size` pixels (a number for a square slice, or
 * [width, height]) at `focal_px`, so its cone's half-extents at unit depth are size / (2 focal). A camera the solve kept
 * no orientation for (`rot` null) has no cone; anything else unreadable refuses the whole file.
 */
export function conesOf(data: unknown): Cone[] {
	const frames = (data as { frames?: unknown } | null)?.frames;
	if (!Array.isArray(frames)) throw new Error('cameras.json has no frames');
	const out: Cone[] = [];
	for (const f of frames as Record<string, unknown>[]) {
		if (f?.rot == null) continue;
		const { pos, rot, solve, focal_px: focal, solver_size: size } = f;
		if (!vec3(pos) || !Array.isArray(rot) || rot.length !== 3 || !rot.every(vec3) ||
			typeof solve !== 'number' || !Number.isInteger(solve) || solve < 0 || typeof focal !== 'number' || !(focal > 0))
			throw new Error(`cameras.json: camera ${String(f?.idx)} has no readable pose`);
		const [w, h] = typeof size === 'number' ? [size, size] : Array.isArray(size) && size.length === 2 ? size : [NaN, NaN];
		if (!(typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0))
			throw new Error(`cameras.json: camera ${String(f.idx)} has no image size`);
		out.push({ pos, rot: rot as Rot, hw: w / (2 * focal), hh: h / (2 * focal), tint: solveTint(solve) });
	}
	return out;
}

type Town = AtlasCamerasTown & { frusta?: CameraFrusta };

export class AtlasCameras {
	readonly object: THREE_NS.Group;
	private readonly towns: Town[];
	private readonly scope: string;
	private disposed = false;

	constructor(private THREE: Three, private o: { towns: AtlasCamerasTown[]; scene: Frame; requests: WorldRequests;
		onChange: () => void }) {
		this.object = new THREE.Group();
		this.object.name = 'atlas cameras';
		this.towns = o.towns.map((t) => ({ ...t }));
		this.scope = o.requests.scope('atlas cameras');
		o.requests.reconcile(this.scope, this.towns.map((t, priority) => ({
			id: t.camerasUrl, label: `${t.label}: cameras`, kind: 'cameras' as const, url: t.camerasUrl, priority,
			cacheable: true,
			run: async (signal: AbortSignal) => {
				const cones = conesOf(await (await responseOrThrow(t.camerasUrl, signal)).json());
				signal.throwIfAborted();
				if (this.disposed) return;
				t.frusta = new CameraFrusta(this.THREE, cones, CAMERA_DEPTH_M);
				t.frusta.lines.matrixAutoUpdate = false;
				this.place(t);
				this.object.add(t.frusta.lines);
				this.o.onChange();
			},
			onState: () => {
				if (!this.disposed) this.o.onChange();
			}
		})));
	}

	private place(t: Town) {
		if (!t.frusta) return;
		t.frusta.lines.matrix.set(...(rigid(t.frame, this.o.scene) as Parameters<THREE_NS.Matrix4['set']>));
		t.frusta.lines.matrixWorldNeedsUpdate = true;
	}

	/** the scene was laid out about another origin: every town's cones placed again, as its points are */
	setScene(scene: Frame) {
		this.o.scene = scene;
		for (const t of this.towns) this.place(t);
	}

	/** the towns whose cameras are drawn, how many cameras, what is still read, and what failed */
	get stats() {
		const jobs = this.o.requests.snapshot().filter((j) => j.wanted && j.scope === this.scope);
		return {
			towns: this.towns.filter((t) => t.frusta).length,
			cameras: this.towns.reduce((n, t) => n + (t.frusta?.count ?? 0), 0),
			loading: jobs.filter((j) => ['queued', 'loading', 'retrying'].includes(j.state)).length,
			errors: jobs.filter((j) => j.error).map((j) => `${j.label}: ${j.error}`)
		};
	}

	get settled() {
		return this.stats.loading === 0;
	}

	dispose() {
		this.disposed = true;
		this.o.requests.release(this.scope);
		for (const t of this.towns) t.frusta?.dispose();
		this.object.removeFromParent();
	}
}
