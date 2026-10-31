/**
 * What the camera sees, as the tile layers choose by it (terrainTiles' View), and when to ask them
 * again: WHAT IT SEES, not only where it is. Zooming or turning in place used to ask for nothing, so
 * a telephoto view of a ridge 30 km off stayed drawn from the tiles chosen for a wide one.
 */
import type * as THREE_NS from 'three';
import type { View } from './terrainTiles';

/** the camera's view for tile selection; `scratch` is a vector to write the direction into */
export function cameraView(camera: THREE_NS.PerspectiveCamera, scratch: THREE_NS.Vector3, heightPx: number): View {
	const d = camera.getWorldDirection(scratch);
	// the field of view actually drawn: a camera.zoom narrows it as fov does
	const fovY = (2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) / (camera.zoom || 1)) * 180) / Math.PI;
	return { dir: [d.x, d.y, d.z], fovY, aspect: camera.aspect, heightPx };
}

/**
 * Re-select layers for what the camera sees, at most once per `minMs` while it changes, and not at
 * all while it does not. `reset` makes the next ask go through (a layer loaded, a layer added).
 */
export class ViewGate {
	private pose = '';
	private t = -Infinity;
	constructor(private minMs = 330) {}

	due(position: ArrayLike<number>, view: View, now: number, force = false): boolean {
		const pose = [...Array.from(position, (v) => v.toFixed(1)), ...view.dir.map((v) => v.toFixed(3)),
			view.fovY.toPrecision(3), view.heightPx].join(',');
		if (!force && (pose === this.pose || now - this.t < this.minMs)) return false;
		this.pose = pose;
		this.t = now;
		return true;
	}

	reset() {
		this.pose = '';
	}
}
