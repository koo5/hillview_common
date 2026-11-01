import type * as THREE_NS from 'three';
import type {CopcNode} from './copcSource';
import type {Vec3} from './geodesy';

/** Rank requested detail across depths, after the initial one-node overview.
 * A shallow distant node must not precede a deeper nearby surface simply because
 * of its octree level. Keep coarse off-screen coverage last, never as a download
 * barrier in front of visible detail. Eligibility/density thresholds are unchanged.
 */
export function planWorldView(nodes:CopcNode[],
 measure:(node:CopcNode)=>{visible:boolean;distance:number;pixels:number}) {
 const ranked=nodes.map((node,index)=>({node,index,...measure(node)}))
  .filter(r=>r.node.depth<=1||(r.visible&&r.pixels>=64));
 ranked.sort((a,b)=>Number(b.visible)-Number(a.visible)||a.distance-b.distance||a.node.depth-b.node.depth||a.index-b.index);
 return ranked.map(r=>r.node);
}


/** Publish nearby detail before grouping the small trailing blocks into bulk
 * geometry updates. Raw point and decoder/concurrency bounds stay unchanged. */
export function worldBatch(priorityPoints:number,hasCloud:boolean){
 return {maxNodes:hasCloud?(priorityPoints<200000?12:64):1,
  rawPoints:Math.max(400000,Math.min(2000000,priorityPoints*2)),
  separateNear:priorityPoints<200000};
}


/** How the camera sees each node, for planWorldView: in its frustum (reversed-Z aware), how far its box
 * is, how many pixels its bounding sphere spans. `offset` carries the tree's file coordinates into the
 * scene; `heightPx` is the drawing buffer's height in device pixels. `nearGroups` holds each measured
 * node's distance group (log2 metres, -1 off screen), which worldBatch keeps apart near the camera. */
export function cameraMeasure(THREE: typeof THREE_NS, camera: THREE_NS.PerspectiveCamera, offset: Vec3,
	heightPx: number, reversed: boolean) {
	camera.updateMatrixWorld();
	const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
	const frustum = new THREE.Frustum().setFromProjectionMatrix(matrix, THREE.WebGLCoordinateSystem, reversed);
	const at = new THREE.Vector3(...offset);
	const box = new THREE.Box3(), sphere = new THREE.Sphere();
	const factor = heightPx / (2 * Math.tan(((camera.fov / 2) * Math.PI) / 180));
	const nearGroups = new Map<string, number>();
	const measure = (node: CopcNode) => {
		box.min.set(node.bounds[0], node.bounds[1], node.bounds[2]).add(at);
		box.max.set(node.bounds[3], node.bounds[4], node.bounds[5]).add(at);
		box.getBoundingSphere(sphere);
		// The bounding sphere can enclose the eye even when a large voxel is far
		// away diagonally. Distance to its box preserves actual spatial priority.
		const distance = Math.max(1, box.distanceToPoint(camera.position));
		const projectedDistance = Math.max(1, camera.position.distanceTo(sphere.center) - sphere.radius);
		const visible = frustum.intersectsBox(box);
		nearGroups.set(node.key, visible ? Math.floor(Math.log2(distance)) : -1);
		return { visible, distance, pixels: sphere.radius * 2 * factor / projectedDistance };
	};
	return { measure, nearGroups };
}
