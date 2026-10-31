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

	/** whether to ask the layers now; a caller drawing only on change asks again on 'soon' */
	state(position: ArrayLike<number>, view: View, now: number, force = false): 'due' | 'soon' | 'same' {
		const pose = [...Array.from(position, (v) => v.toFixed(1)), ...view.dir.map((v) => v.toFixed(3)),
			view.fovY.toPrecision(3), view.heightPx].join(',');
		if (!force && pose === this.pose) return 'same';
		if (!force && now - this.t < this.minMs) return 'soon';
		this.pose = pose;
		this.t = now;
		return 'due';
	}

	due(position: ArrayLike<number>, view: View, now: number, force = false): boolean {
		return this.state(position, view, now, force) === 'due';
	}

	/** the interval: how long a 'soon' waits at most */
	get interval() {
		return this.minMs;
	}

	reset() {
		this.pose = '';
	}
}
