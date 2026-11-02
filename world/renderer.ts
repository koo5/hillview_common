/**
 * The world's WebGL renderer: reversed-Z depth where the GPU has it (a far ridge and the ground
 * under the eye both keep their precision), and three's render lists put back in order under it.
 */
import type * as THREE_NS from 'three';

export type DepthMode = 'reversed' | 'standard';

type Item = { groupOrder: number; renderOrder: number; z: number; id: number;
	material: { id: number }; materialVariant?: number };

/** `reversed: false` asks for the old mapping: a way back if a GPU gets reversed-Z wrong */
export function createWorldRenderer(THREE: typeof THREE_NS, opts: { reversed: boolean }):
	{ renderer: THREE_NS.WebGLRenderer; depthMode: DepthMode } {
	const renderer = new THREE.WebGLRenderer({ antialias: true, reversedDepthBuffer: opts.reversed });
	const depthMode: DepthMode = renderer.capabilities.reversedDepthBuffer ? 'reversed' : 'standard';
	if (depthMode === 'reversed') {
		// THREE r185 REVERSES ITS WHOLE RENDER LISTS under a reversed depth buffer -- to turn
		// its depth order round, but renderOrder is turned round with it. The sky
		// (renderOrder -1e6, drawn first, no depth test) was drawn LAST and painted over
		// every point; every overlay that relies on its order would invert the same way.
		// So the lists are sorted here into the inverse of the order wanted, and three's
		// reverse puts them right: renderOrder first as always, then near-first for opaque
		// and far-first for transparent -- in reversed depth a larger z is NEARER.
		const opaque = (a: Item, b: Item) =>
			a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder ||
			a.material.id - b.material.id || (a.materialVariant ?? 0) - (b.materialVariant ?? 0) ||
			b.z - a.z || a.id - b.id;
		const transparent = (a: Item, b: Item) =>
			a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.z - b.z || a.id - b.id;
		renderer.setOpaqueSort((a: Item, b: Item) => -opaque(a, b));
		renderer.setTransparentSort((a: Item, b: Item) => -transparent(a, b));
	}
	renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
	return { renderer, depthMode };
}

/**
 * The frame drawn into a target whose depth can be read back (DepthProbe: which names the scene hides), then put on
 * the screen as drawn. A scene renders through it only while something reads its depth; MSAA as the canvas has it.
 */
export class DepthTarget {
	readonly target: THREE_NS.WebGLRenderTarget;
	private quadScene: THREE_NS.Scene;
	private quadCam: THREE_NS.OrthographicCamera;
	private quad: THREE_NS.Mesh;

	constructor(THREE: typeof THREE_NS, w: number, h: number, depthMode: DepthMode) {
		this.target = new THREE.WebGLRenderTarget(w, h, {
			// linear colour through the copy, as the canvas would have it
			type: THREE.HalfFloatType,
			samples: 4,
			depthTexture: new THREE.DepthTexture(w, h, depthMode === 'reversed' ? THREE.FloatType : undefined)
		});
		this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
			new THREE.MeshBasicMaterial({ map: this.target.texture, depthTest: false, depthWrite: false }));
		this.quadScene = new THREE.Scene();
		this.quadScene.add(this.quad);
		this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	}

	setSize(w: number, h: number) {
		if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
	}

	render(renderer: THREE_NS.WebGLRenderer, scene: THREE_NS.Scene, camera: THREE_NS.Camera) {
		renderer.setRenderTarget(this.target);
		renderer.clear();
		renderer.render(scene, camera);
		renderer.setRenderTarget(null);
		renderer.render(this.quadScene, this.quadCam);
	}

	dispose() {
		this.target.depthTexture?.dispose();
		this.target.dispose();
		this.quad.geometry.dispose();
		(this.quad.material as THREE_NS.Material).dispose();
	}
}
