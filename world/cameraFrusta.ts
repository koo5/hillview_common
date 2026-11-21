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
const SKIP: [number, number][] = [[25, 65], [95, 160]];
const ALLOWED = 360 - SKIP.reduce((s, [a, b]) => s + b - a, 0);

/** the tint of solve `i` (0-based): golden-angle steps through the hues outside SKIP, so neighbours differ most */
export function solveTint(i: number): number {
	let h = ((i * 137.50776405) % 360) * (ALLOWED / 360);
	for (const [a, b] of SKIP) if (h >= a) h += b - a;
	return hsl(h, 0.8, 0.6);
}

function hsl(h: number, s: number, l: number): number {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
	};
	return (f(0) << 16) | (f(8) << 8) | f(4);
}
