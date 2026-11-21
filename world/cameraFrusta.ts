/**
 * Camera frusta, every camera of a layer in ONE LineSegments.
 *
 * A cone per camera, drawn as an object of its own, costs a draw call each: a town's 7,048 cameras made 14,203 draw
 * calls a render (with a number sprite each) and took the renderer from 0.5 to 76 ms of CPU a render. The geometry is
 * small (16 line vertices a cone), so the whole layer is one geometry and one draw.
 *
 * Each vertex is the camera's centre (`position`) plus the depth times its `offset`: the camera's rotation applied to
 * the cone's corner at unit depth (zero at the apex). The depth is a uniform, so changing it rebuilds nothing; moving a
 * camera rewrites its own 16 vertices.
 *
 * The cone reads as one: the apex near white, the rays running to the image plane, whose top edge (camera y = -hh,
 * camera space being y DOWN) keeps the tint while the bottom edge is green, so a photograph's orientation shows. The
 * colours are authored in sRGB and decoded in the shader; three's output conversion does the rest.
 */
import type * as THREE_NS from 'three';

type Three = typeof THREE_NS;
export type Vec3 = [number, number, number];
/** a rotation, camera to scene: row i is scene axis i; its columns are the camera's x (right), y (down), z (forward) */
export type Rot = [Vec3, Vec3, Vec3];

/** one camera: where it stands, how it turns, its half-extents at unit depth (w/2f, h/2f) and its tint (0xrrggbb) */
export type Cone = { pos: Vec3; rot: Rot; hw: number; hh: number; tint: number };

/** line vertices per cone: four rays and the image plane's four edges */
export const CONE_VERTICES = 16;

const GREEN = [0.27, 0.86, 0.42];

/** the cone's 16 vertices at unit depth in camera space, and the colour of each, for a tint */
function template(hw: number, hh: number, tint: number): { local: number[]; colour: number[] } {
	const t = [((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255];
	const apex = t.map((c) => c + (1 - c) * 0.7);
	// the tint's top edge runs to a green bottom edge, mixed in so another run's tint stays its own
	const bottom = t.map((c, i) => c * 0.2 + GREEN[i] * 0.8);
	const corners: [number, number, number[]][] = [[-hw, -hh, t], [hw, -hh, t], [hw, hh, bottom], [-hw, hh, bottom]];
	const local: number[] = [], colour: number[] = [];
	for (let i = 0; i < 4; i++) {
		const [x, y, c] = corners[i];
		const [nx, ny, nc] = corners[(i + 1) % 4];
		local.push(0, 0, 0, x, y, 1, x, y, 1, nx, ny, 1);
		colour.push(...apex, ...c, ...c, ...nc);
	}
	return { local, colour };
}

export class CameraFrusta {
	readonly lines: THREE_NS.LineSegments;
	private readonly position: THREE_NS.BufferAttribute;
	private readonly offset: THREE_NS.BufferAttribute;
	private readonly colour: THREE_NS.BufferAttribute;
	private readonly material: THREE_NS.ShaderMaterial;
	private readonly sizes: Float32Array;

	constructor(THREE: Three, cones: Cone[], depth: number) {
		const n = cones.length * CONE_VERTICES;
		this.position = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
		this.offset = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
		this.colour = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
		this.sizes = new Float32Array(cones.length * 2);
		cones.forEach((c, i) => {
			this.sizes[i * 2] = c.hw;
			this.sizes[i * 2 + 1] = c.hh;
			const { colour } = template(c.hw, c.hh, c.tint);
			(this.colour.array as Float32Array).set(colour, i * CONE_VERTICES * 3);
			this.write(i, c.pos, c.rot);
		});
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', this.position);
		g.setAttribute('offset', this.offset);
		g.setAttribute('color', this.colour);
		this.material = new THREE.ShaderMaterial({
			uniforms: { depth: { value: depth } },
			vertexShader: `
				#include <common>
				#include <logdepthbuf_pars_vertex>
				attribute vec3 offset;
				attribute vec3 color;
				uniform float depth;
				varying vec3 vColor;
				void main() {
					vColor = color;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position + depth * offset, 1.0);
					#include <logdepthbuf_vertex>
				}
			`,
			fragmentShader: `
				#include <logdepthbuf_pars_fragment>
				varying vec3 vColor;
				void main() {
					#include <logdepthbuf_fragment>
					gl_FragColor = sRGBTransferEOTF(vec4(vColor, 1.0));
					#include <colorspace_fragment>
				}
			`
		});
		this.lines = new THREE.LineSegments(g, this.material);
		this.lines.name = 'camera frusta';
		// one object over a whole town: its apexes' sphere would leave out the cones' depth, and culling it saves nothing
		this.lines.frustumCulled = false;
	}

	get count() {
		return this.sizes.length / 2;
	}

	get depth(): number {
		return this.material.uniforms.depth.value;
	}

	/** the image plane's distance from every camera, in scene units */
	setDepth(depth: number) {
		this.material.uniforms.depth.value = depth;
	}

	/** camera `i` moved (a replay): its 16 vertices rewritten */
	setPose(i: number, pos: Vec3, rot: Rot) {
		if (!(i >= 0 && i < this.count)) throw new Error(`camera frusta: no cone ${i} of ${this.count}`);
		this.write(i, pos, rot);
		this.position.needsUpdate = true;
		this.offset.needsUpdate = true;
	}

	/** where camera `i`'s vertex `v` stands (scene units, at the current depth): for tests and picking */
	vertex(i: number, v: number): Vec3 {
		const k = (i * CONE_VERTICES + v) * 3, p = this.position.array, o = this.offset.array, d = this.depth;
		return [p[k] + d * o[k], p[k + 1] + d * o[k + 1], p[k + 2] + d * o[k + 2]];
	}

	private write(i: number, pos: Vec3, rot: Rot) {
		const { local } = template(this.sizes[i * 2], this.sizes[i * 2 + 1], 0);
		const p = this.position.array as Float32Array, o = this.offset.array as Float32Array;
		for (let v = 0; v < CONE_VERTICES; v++) {
			const k = (i * CONE_VERTICES + v) * 3, x = local[v * 3], y = local[v * 3 + 1], z = local[v * 3 + 2];
			p[k] = pos[0]; p[k + 1] = pos[1]; p[k + 2] = pos[2];
			o[k] = rot[0][0] * x + rot[0][1] * y + rot[0][2] * z;
			o[k + 1] = rot[1][0] * x + rot[1][1] * y + rot[1][2] * z;
			o[k + 2] = rot[2][0] * x + rot[2][1] * y + rot[2][2] * z;
		}
	}

	dispose() {
		this.lines.geometry.dispose();
		this.material.dispose();
		this.lines.removeFromParent();
	}
}

// hue bands left out of the palette: amber to yellow (an injected photograph's cameras, and the workbench's highlight)
// and the green of every bottom edge
const SKIP: [number, number][] = [[25, 70], [95, 160]];
const LEVELS = [0.45, 0.58, 0.71];
const HUE_STEP = 3;
/** the first solve's colour: the blue a run's own cameras have always had */
const FIRST = { h: 210, l: 0.58 };
/** colours no solve should look like, counted as if taken before the first: the cones' green bottom edge (their
 * orientation cue), the workbench's highlight yellow and an injected photograph's amber */
export const RESERVED_TINTS = [(Math.round(GREEN[0] * 255) << 16) | (Math.round(GREEN[1] * 255) << 8) | Math.round(GREEN[2] * 255),
	0xffd54f, 0xe0a23a];
/** how far in OKLab every solve's colour stays from each reserved one */
export const KEEP_OFF = 0.12;

type Candidate = { h: number; l: number; rgb: number; lab: [number, number, number] };
let candidates: Candidate[] | null = null;
/** the candidate each solve took, in order; and each candidate's distance to the nearest colour taken or reserved */
const taken: number[] = [];
let nearest: number[] = [];

/**
 * The tint of solve `i` (0-based). Each solve takes, of the candidate colours (the hues outside SKIP at three
 * lightnesses), the one farthest in OKLab from every colour the solves before it took and from RESERVED_TINTS: so any
 * number of solves are spread as far apart as the candidates allow, none crowds the colours the cameras already use,
 * and a solve's colour never depends on how many come after it. Golden-angle hues alone come back within a few degrees
 * at Fibonacci distances (solves 0 and 34, 3.4 degrees).
 */
export function solveTint(i: number): number {
	if (!Number.isInteger(i) || i < 0) throw new Error(`solveTint: ${i} is not a solve index`);
	const c = (candidates ??= makeCandidates());
	if (!nearest.length) {
		const reserved = RESERVED_TINTS.map(oklab);
		nearest = c.map((x) => Math.min(...reserved.map((r) => labDistance(x.lab, r))));
	}
	while (taken.length <= i) {
		let k: number;
		if (taken.length >= c.length) k = taken[taken.length - c.length];    // every candidate taken: they repeat in order
		else if (!taken.length) k = c.findIndex((x) => x.h === FIRST.h && x.l === FIRST.l);
		else {
			k = 0;
			for (let j = 1; j < c.length; j++) if (nearest[j] > nearest[k]) k = j;
		}
		const at = c[k].lab;
		nearest = nearest.map((d, j) => Math.min(d, labDistance(c[j].lab, at)));
		taken.push(k);
	}
	return c[taken[i]].rgb;
}

function makeCandidates(): Candidate[] {
	const reserved = RESERVED_TINTS.map(oklab);
	const out: Candidate[] = [];
	for (const l of LEVELS)
		for (let h = 0; h < 360; h += HUE_STEP) {
			if (SKIP.some(([a, b]) => h >= a && h < b)) continue;
			const rgb = hsl(h, 0.8, l), lab = oklab(rgb);
			// a colour this near a reserved one is never offered (the hue bands alone left yellow-greens 0.058 from the edge green)
			if (reserved.some((r) => labDistance(lab, r) < KEEP_OFF)) continue;
			out.push({ h, l, rgb, lab });
		}
	return out;
}

/** an sRGB colour (0xrrggbb) in OKLab */
export function oklab(rgb: number): [number, number, number] {
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const r = lin((rgb >> 16) & 255), g = lin((rgb >> 8) & 255), b = lin(rgb & 255);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

const labDistance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function hsl(h: number, s: number, l: number): number {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
	};
	return (f(0) << 16) | (f(8) << 8) | f(4);
}
