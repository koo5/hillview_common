import type * as THREE_NS from 'three';

type Three = typeof THREE_NS;

/** A held block's rows as the residency keeps them: positions in the cloud's own frame, colours as sRGB bytes. */
export type BlockRows = { readonly positions: Float32Array; readonly colors: Uint8Array };

/**
 * HOW MUCH GOES UP TO THE GPU IN ONE FRAME (ea14 A-1, 2026-11-15). A block's buffers upload on the first render that
 * draws it, so blocks join the drawn set at most this many bytes a frame (and at least one block, however large),
 * nearest first. 24 MiB is about 1.6 M points at 15 B: a fraction of a frame on a desktop GPU, a few frames on a phone.
 */
export const BLOCK_UPLOAD_BYTES = 24 * 1024 * 1024;

/** The GPU's bytes for a block: its positions and its colour bytes, the two attributes drawn. */
export const blockBytes = (rows: BlockRows) => rows.positions.byteLength + rows.colors.byteLength;

/**
 * POINTS WHOSE COLOURS ARE sRGB BYTES. The residency keeps each point's colour as its photograph's three bytes; the
 * renderer wants linear colour, which the viewers used to make on the CPU as a float copy (12 B a point, kept beside the
 * bytes). Here the bytes go to the GPU as they are (a normalized uint8 attribute, 3 B a point) and the vertex shader
 * decodes them with the sRGB curve (IEC 61966-2-1), the one the CPU table used.
 */
export function srgbPointsMaterial(THREE: Three, parameters: THREE_NS.PointsMaterialParameters = {}): THREE_NS.PointsMaterial {
	const material = new THREE.PointsMaterial({ ...parameters, vertexColors: true });
	material.onBeforeCompile = (shader) => {
		if (!shader.vertexShader.includes('#include <color_vertex>')) throw new Error('three changed its point shader: no color_vertex');
		shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_COLOR
	vColor.rgb = mix(vColor.rgb / 12.92, pow((vColor.rgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), vColor.rgb));
#endif`);
	};
	material.customProgramCacheKey = () => 'srgb-bytes-points';
	return material;
}

/**
 * A TREE'S HELD BLOCKS, EACH DRAWN AS ITS OWN POINTS (ea14 A-1, 2026-11-15). The viewers used to concatenate every held
 * block into one new geometry after each batch and upload it whole: at a 256 MiB budget (8.9 M points) every batch cost
 * 125-176 ms of JavaScript and ~215 MB of upload, and at 1024 MiB the operator's world viewer kept freezing (Umami,
 * 11-14). Here a block is uploaded once, when it joins, and its buffers are freed when the residency lets it go.
 *
 * - The attributes ARE the block's own arrays: no copy is made, so the JS side holds what the residency holds.
 * - `sync(blocks)` with the residency's blocks after each change: a block no longer held leaves at once; a new one waits.
 * - `step()` before each render: waiting blocks join, nearest first, up to `uploadBytes` a frame. It says whether more
 *   wait, so a viewer that draws on demand asks for another frame.
 * - Each block has its bounding sphere, so three draws only the blocks in the frustum.
 * - One material for every block: point size and colour are set once for the cloud.
 */
export class BlockCloud {
	/** every drawn block; its matrix carries the cloud's frame into the scene */
	readonly object: THREE_NS.Group;
	readonly material: THREE_NS.PointsMaterial;
	private readonly drawn = new Map<BlockRows, THREE_NS.Points | null>();
	private waiting: BlockRows[] = [];
	private readonly uploadBytes: number;
	private readonly ownsMaterial: boolean;

	constructor(private readonly THREE: Three, o: { material?: THREE_NS.PointsMaterial; uploadBytes?: number } = {}) {
		this.uploadBytes = o.uploadBytes ?? BLOCK_UPLOAD_BYTES;
		if (!(this.uploadBytes > 0)) throw new Error(`a block cloud uploads a positive number of bytes a frame, not ${this.uploadBytes}`);
		this.ownsMaterial = !o.material;
		this.material = o.material ?? srgbPointsMaterial(THREE);
		this.object = new THREE.Group();
	}

	/** The residency's held blocks now, in its rank order (nearest first). */
	sync(blocks: readonly BlockRows[]) {
		const held = new Set(blocks);
		for (const [rows, points] of this.drawn) {
			if (held.has(rows)) continue;
			this.drawn.delete(rows);
			if (points) { this.object.remove(points); points.geometry.dispose(); }
		}
		this.waiting = blocks.filter((rows) => !this.drawn.has(rows));
	}

	/** Before a render: waiting blocks join, up to the frame's upload. True while more wait. */
	step(): boolean {
		let bytes = 0, taken = 0;
		for (const rows of this.waiting) {
			const cost = blockBytes(rows);
			if (taken && bytes + cost > this.uploadBytes) break;
			this.add(rows);
			bytes += cost;
			taken++;
		}
		this.waiting = this.waiting.slice(taken);
		return this.waiting.length > 0;
	}

	private add(rows: BlockRows) {
		const n = rows.positions.length / 3;
		if (!Number.isInteger(n) || rows.colors.length !== n * 3) throw new Error('a block needs three colour bytes for each position');
		if (!n) { this.drawn.set(rows, null); return; }
		const THREE = this.THREE, g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(rows.positions, 3));
		g.setAttribute('color', new THREE.BufferAttribute(rows.colors, 3, true));
		g.computeBoundingSphere();
		const points = new THREE.Points(g, this.material);
		this.object.add(points);
		this.drawn.set(rows, points);
	}

	/** points drawn now (joined blocks only) */
	get points(): number {
		let n = 0;
		for (const rows of this.drawn.keys()) n += rows.positions.length / 3;
		return n;
	}

	/** held blocks not drawn yet */
	get waitingBlocks(): number {
		return this.waiting.length;
	}

	dispose() {
		for (const points of this.drawn.values()) if (points) { this.object.remove(points); points.geometry.dispose(); }
		this.drawn.clear();
		this.waiting = [];
		// a material the caller passed is the caller's to dispose
		if (this.ownsMaterial) this.material.dispose();
	}
}
