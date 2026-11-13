import { localAxes } from './compass';
import { scaledFov } from './flight';
import { Frame, type Vec3 } from './geodesy';

export type Point = { x: number; y: number };
export type TouchPair = Point & { distance: number };

/** Sample both fingers together once per frame: sequential pointer events must not turn a symmetric pinch into travel. */
export function touchPair(points: readonly Point[]): TouchPair | null {
	if (points.length !== 2) return null;
	const [a, b] = points;
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
}

/** A pinch's tiny centre jitter must not start flight. Keep slow, intentional drags by accumulating until 3 px. */
export class TouchTravel {
	private x = 0;
	private y = 0;
	private active = false;
	reset() {
		this.x = this.y = 0;
		this.active = false;
	}
	move(dx: number, dy: number): Point | null {
		this.x += dx;
		this.y += dy;
		if (!this.active && Math.hypot(this.x, this.y) <= 3) return null;
		this.active = true;
		const delta = { x: this.x, y: this.y };
		this.x = this.y = 0;
		return Math.hypot(delta.x, delta.y) > 1e-6 ? delta : null;
	}
}

/** Pixel, line and page wheels have the same sensitivity after normalizing their units. */
export function wheelFov(fov: number, deltaY: number, deltaMode: number, viewportHeight: number): number {
	const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, viewportHeight) : 1);
	return scaledFov(fov, Math.exp(Math.max(-600, Math.min(600, pixels)) * 0.0015));
}

/** A screen-relative distance: precise near the ground or zoomed in, larger when high above it. */
export function touchMetresPerPixel(clearance: number, fov: number, viewportHeight: number): number {
	return 2 * Math.max(1.5, clearance) * Math.tan(fov * Math.PI / 360) / Math.max(1, viewportHeight);
}

/** Up goes forward and right sidesteps right, relative to true heading. Looking down or rolling does not change altitude. */
export function groundDrag(frame: Frame, position: Vec3, bearing: number, dx: number, dy: number, metresPerPixel: number): Vec3 {
	const { e, n } = localAxes(frame, position);
	const radians = bearing * Math.PI / 180;
	const right = dx * metresPerPixel, forward = -dy * metresPerPixel;
	const east = right * Math.cos(radians) + forward * Math.sin(radians);
	const north = forward * Math.cos(radians) - right * Math.sin(radians);
	const next = position.map((v, i) => v + east * e[i] + north * n[i]) as Vec3;
	const [lat, lon] = frame.toGeodetic(...next);
	const altitude = frame.toGeodetic(...position)[2];
	return frame.fromGeodetic(lat, lon, altitude);
}
