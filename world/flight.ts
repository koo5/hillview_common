/**
 * Flight (moved from the workbench's run viewer, ea07): Descent-style six degrees of freedom, a ship in free space --
 * no gravity, no up. Thrust is along the camera's own axes and eases in and out (integrateFlyMotion); look turns
 * about the camera's own axes (lookRotate); roll is on two keys and another levels the wings. Both the run viewer
 * and the public scene fly with this; what takes the mouse (a pointer lock, a drag) is each viewer's own.
 *
 * Keys are bound by PHYSICAL key (event.code), so the cluster is the same four keys under any layout -- a Colemak
 * board just prints W A R S on them. What a layout changes is the labels, and the few keys outside the cluster that
 * are chosen by letter. Only the layout's letter keys fly (the user, 2026-09-17): no Space for up, no Shift for down,
 * no arrows, so the keys a page and its controls want -- arrows, Space, Enter -- are never taken from them.
 */
import type * as THREE_NS from 'three';

type Three = typeof THREE_NS;

export const DEFAULT_FLY_MPS = 5;
export const MIN_FLY_MPS = 0.001;
/** 1000 km/s: across the country in half a second, round the earth in 40 s. 10 km/s was too slow for a scene that holds
 * the whole earth (the operator, 2026-11-10: "we should raise the 10km/s limit") */
export const MAX_FLY_MPS = 1_000_000;
export const FLY_SPEED_PREF = 'world.fly.speedMps';
export const FLY_LAYOUT_PREF = 'world.fly.layout';
/** roll on its keys, radians a second */
export const ROLL_RATE = 1.6;
/** look: radians per pixel of mouse movement at a 55° field of view */
export const LOOK_RAD_PER_PX = 0.0022;
const DRAG = -Math.log(0.02);

/** how far a point is from a flown path, in metres by the local scale of a degree (the points are a flight's, metres
 * apart: no need of a frame's exact geodesy); Infinity with no path. To the path's SEGMENTS, not only its points: a map
 * echoes where its pan got to, and a pan a newer report cut short stops between two reports, on the line joining them
 * (world-far-view.spec, 2026-11-08: at 1500 m/s the reports were 450 m apart, and an echo 0.02 m off the line but
 * 8.7 m from its nearest report landed the flight) */
export function pathOffsetM(path: readonly { lat: number; lon: number }[], lat: number, lon: number): number {
	const mLat = 111_320, mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
	let best = Infinity;
	for (let i = 0; i < path.length; i++) {
		const a = path[i], b = path[i + 1] ?? a;
		const ax = (a.lon - lon) * mLon, ay = (a.lat - lat) * mLat;
		const dx = (b.lon - a.lon) * mLon, dy = (b.lat - a.lat) * mLat;
		const len2 = dx * dx + dy * dy;
		const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
		best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
	}
	return best;
}

export function boundedFlySpeed(value: number): number {
	return Math.max(MIN_FLY_MPS, Math.min(MAX_FLY_MPS, value));
}

export function savedFlySpeed(value: string | null): number {
	const n = value === null ? NaN : Number(value);
	return Number.isFinite(n) && n > 0 ? boundedFlySpeed(n) : DEFAULT_FLY_MPS;
}

/** Exact integration of eased camera-local velocity. No scene/altitude inputs.
 * Mutates velocity and thrust; returns displacement in metres for elapsed seconds.
 * Easing keeps 2% of the velocity difference after one second at every cadence.
 */
export function integrateFlyMotion(velocity: THREE_NS.Vector3, thrust: THREE_NS.Vector3, speed: number, dt: number):
	THREE_NS.Vector3 {
	const target = thrust.clampLength(0, 1).multiplyScalar(speed);
	velocity.clampLength(0, speed); // A lower setting immediately caps existing momentum.
	const blend = -Math.expm1(-DRAG * dt);
	const step = velocity.clone().sub(target).multiplyScalar(blend / DRAG).addScaledVector(target, dt);
	velocity.lerp(target, blend);
	if (!target.lengthSq() && velocity.length() < speed * 0.0001) velocity.set(0, 0, 0);
	return step;
}

export type FlyLayout = 'qwerty' | 'colemak';
export type FlyAction = 'fwd' | 'left' | 'back' | 'right' | 'up' | 'down' | 'rollL' | 'rollR' | 'level';

export const FLY_LAYOUTS: Record<FlyLayout, { label: string; keys: Record<FlyAction, string> }> = {
	qwerty: {
		label: 'W A S D · R/F up/down · Q/E roll · L level',
		keys: { fwd: 'KeyW', left: 'KeyA', back: 'KeyS', right: 'KeyD',
			up: 'KeyR', down: 'KeyF', rollL: 'KeyQ', rollR: 'KeyE', level: 'KeyL' }
	},
	colemak: {
		// same physical cluster (caps read W A R S), up/down on the keys above and
		// below it that read P and T, roll on Q and F, level on the key that reads L
		label: 'W A R S · P/T up/down · Q/F roll · L level',
		keys: { fwd: 'KeyW', left: 'KeyA', back: 'KeyS', right: 'KeyD',
			up: 'KeyR', down: 'KeyF', rollL: 'KeyQ', rollR: 'KeyE', level: 'KeyU' }
	}
};

export function savedFlyLayout(value: string | null): FlyLayout {
	return value === 'colemak' ? 'colemak' : 'qwerty';
}

/**
 * The keys that narrow and widen the view: each app's own. The workbench's are Z and X; Hillview's Z and X turn the
 * view to a photo, so its scene zooms on + (=) and -, the keys its map zooms on when the map has focus (the
 * operator, 2026-11-02).
 */
export type ZoomKeys = { by: 'code' | 'key'; narrow: readonly string[]; widen: readonly string[]; label: string };
/** a position, like the flight keys (e.code) */
export const ZOOM_ZX: ZoomKeys = { by: 'code', narrow: ['KeyZ'], widen: ['KeyX'], label: 'Z/X zoom' };
/** the characters, as Hillview's own shortcuts are (e.key): on a Czech QWERTZ the Equal position types ´ and + is
 * on Digit1 (RECON-UI, 11-02); the keypad's keys type + and - too */
export const ZOOM_PLUS_MINUS: ZoomKeys = { by: 'key', narrow: ['+', '='], widen: ['-'], label: '+/− zoom' };

/** A narrowing key narrows the view, a widening one widens it, in equal steps even at very narrow fields of view;
 * null for any other key */
export function zoomedFov(fovDeg: number, e: { code: string; key: string }, keys: ZoomKeys): number | null {
	const k = keys.by === 'key' ? e.key : e.code;
	const narrow = keys.narrow.includes(k);
	if (!narrow && !keys.widen.includes(k)) return null;
	const scale = narrow ? 1 / 1.1 : 1.1;
	const fov = (2 * Math.atan(Math.tan((fovDeg * Math.PI) / 360) * scale) * 180) / Math.PI;
	return Math.max(0.1, Math.min(120, fov));
}

/**
 * A key aimed at a control that uses it belongs to that control, not to the flight: a W in a text field, or a
 * letter a select takes as type-ahead, must not thrust the camera. While the pointer is locked you are flying and
 * nothing else has the keyboard. Checkboxes and buttons stay with flight: they answer to Space and Enter, which
 * flight does not take.
 */
export function keyBelongsToControl(e: KeyboardEvent, locked: boolean): boolean {
	if (locked) return false;
	const t = e.target as HTMLElement | null;
	if (!t) return false;
	if (t.isContentEditable || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return true;
	return t instanceof HTMLInputElement && !['checkbox', 'button', 'submit', 'reset', 'radio'].includes(t.type);
}

/** the keys held, read as the layout's actions */
export class FlyKeys {
	private held = new Set<string>();
	layout: FlyLayout;
	constructor(layout: FlyLayout = 'qwerty') {
		this.layout = layout;
	}
	/** a key went down; true when it is one of the layout's flight keys */
	press(code: string): boolean {
		this.held.add(code);
		return Object.values(FLY_LAYOUTS[this.layout].keys).includes(code);
	}
	release(code: string) {
		this.held.delete(code);
	}
	clear() {
		this.held.clear();
	}
	down(action: FlyAction): boolean {
		return this.held.has(FLY_LAYOUTS[this.layout].keys[action]);
	}
	/** any flight key held */
	get flying(): boolean {
		return (Object.keys(FLY_LAYOUTS[this.layout].keys) as FlyAction[]).some((a) => this.down(a));
	}
	/** camera-local thrust from the keys, -1..1 per axis: x right, y up, z back (three's camera looks down -z) */
	thrust(): [number, number, number] {
		const k = (a: FlyAction) => (this.down(a) ? 1 : 0);
		return [k('right') - k('left'), k('up') - k('down'), k('back') - k('fwd')];
	}
	/** roll from the keys: +1 left, -1 right */
	roll(): number {
		return (this.down('rollL') ? 1 : 0) - (this.down('rollR') ? 1 : 0);
	}
}

/** Roll back to horizontal without changing where the camera points: the orientation rebuilt from the current
 * forward vector and the world's up (z, the frames here are ENU). */
export function levelWings(THREE: Three, camera: THREE_NS.Camera) {
	const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
	if (Math.abs(fwd.z) > 0.999) return;
	const target = camera.position.clone().add(fwd);
	camera.up.set(0, 0, 1);
	camera.lookAt(target);
}

/** a pull of -1..1 straight along the earth's up `up` (world coordinates: compass.localAxes(..).u at the camera), as
 * the camera-local thrust Flight.step takes: a height control changes the height and only that, whichever way the
 * camera looks or is rolled -- along the camera's own up, looking down it slid the ship over the ground (the
 * operator, 2026-11-10: "perpendicular to earth, not your own axis"). The keys keep the ship's own axes. */
export function earthUpThrust(up: THREE_NS.Vector3, quaternion: THREE_NS.Quaternion, pull: number): [number, number, number] {
	const v = up.clone().applyQuaternion(quaternion.clone().invert()).multiplyScalar(pull);
	return [v.x, v.y, v.z];
}

/** the mouse's angular scale at this field of view: the visible span moves with the hand at any zoom */
export function lookScale(camera: THREE_NS.PerspectiveCamera): number {
	return Math.tan((camera.fov * Math.PI) / 360) / Math.tan((55 * Math.PI) / 360);
}

/**
 * Descent (the user, 2026-09-15: "a spaceship in free space"): a frame's mouse movement is ONE rotation about one
 * axis in the ship's own frame -- right turns about its up, down about its right -- composed onto the orientation.
 * No world up anywhere; roll that builds up is flight. GATHER a frame's movement and turn once: a yaw then a pitch
 * per event do not commute, and pointer lock on Linux Chrome sends pairs that cancel (+d then -d), each leaving a
 * net rotation behind (measured 2026-09-15).
 */
export function lookRotate(THREE: Three, camera: THREE_NS.PerspectiveCamera, dxPx: number, dyPx: number) {
	if (dxPx === 0 && dyPx === 0) return;
	const angle = Math.hypot(dxPx, dyPx) * LOOK_RAD_PER_PX * lookScale(camera);
	const axis = new THREE.Vector3(-dyPx, -dxPx, 0).normalize();
	camera.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle)).normalize();
}

/** One ship: the held keys, the momentum and the look gathered between frames, flown a frame at a time. A viewer
 * owns what feeds it (its key events, its mouse or touch pads) and what the camera means afterwards. */
export class Flight {
	speed: number;
	private velocity: THREE_NS.Vector3;
	private lookPx: [number, number] = [0, 0];
	constructor(private THREE: Three, readonly keys: FlyKeys, speed: number) {
		this.speed = speed;
		this.velocity = new THREE.Vector3();
	}
	/** mouse movement for the next frame, in lookRotate's pixels */
	look(dx: number, dy: number) {
		this.lookPx[0] += dx;
		this.lookPx[1] += dy;
	}
	/** one frame of `dt` seconds, with what other controls add to the keys (touch pads: thrust per axis, roll);
	 * true while anything still moves (a key held, momentum left) */
	step(camera: THREE_NS.PerspectiveCamera, dt: number, extra: { thrust?: [number, number, number]; roll?: number } = {}): boolean {
		lookRotate(this.THREE, camera, ...this.lookPx);
		this.lookPx = [0, 0];
		const [kx, ky, kz] = this.keys.thrust(), [ex, ey, ez] = extra.thrust ?? [0, 0, 0];
		const thrust = new this.THREE.Vector3(kx + ex, ky + ey, kz + ez);
		camera.position.add(integrateFlyMotion(this.velocity, thrust, this.speed, dt).applyQuaternion(camera.quaternion));
		const roll = this.keys.roll() + (extra.roll ?? 0);
		if (roll) camera.rotateZ(ROLL_RATE * dt * roll);
		if (this.keys.down('level')) levelWings(this.THREE, camera);
		return this.keys.flying || thrust.lengthSq() > 0 || this.velocity.lengthSq() > 0;
	}
	/** momentum stopped on these camera-local axes (a released touch pad stops its own, not another's) */
	halt(axes: { x?: boolean; y?: boolean; z?: boolean } = { x: true, y: true, z: true }) {
		if (axes.x) this.velocity.x = 0;
		if (axes.y) this.velocity.y = 0;
		if (axes.z) this.velocity.z = 0;
	}
	/** every key let go and the ship at rest */
	stop() {
		this.keys.clear();
		this.halt();
		this.lookPx = [0, 0];
	}
}
