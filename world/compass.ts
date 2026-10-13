/**
 * The heading tape (2026-10-02): which way the view looks, as a strip of bearings along the bottom
 * of the picture -- N, NE, E ... and degrees, ticked as finely as the zoom allows -- with the
 * bearing, pitch and field of view at its centre.
 *
 * TRUE north AT THE CAMERA, not the world frame's: the scene is drawn in one tangent frame about
 * the world's origin, and 20 km east of it that frame's +y is already 0.2 degrees off north
 * (meridian convergence). A telephoto view is a degree wide, so the tape is computed in the
 * camera's own east/north/up (`localAxes`), from geodesy -- as the photos' bearings are.
 */
import { Frame, type Vec3 } from './geodesy';

export type Axes = { e: Vec3; n: Vec3; u: Vec3 };

/** the camera's own east, north and up, in the world frame's coordinates; plain ENU without one */
export function localAxes(world: Frame | null, camWorld: Vec3): Axes {
	if (!world) return { e: [1, 0, 0], n: [0, 1, 0], u: [0, 0, 1] };
	const [lat, lon, h] = world.toGeodetic(...camWorld);
	const here = new Frame(lat, lon, h);
	// each local axis is an ECEF direction (a row of here.R); world coordinates = world.R . v
	const toWorld = (v: Vec3): Vec3 => {
		const R = world.R;
		return [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
			R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
			R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
	};
	return { e: toWorld(here.R[0]), n: toWorld(here.R[1]), u: toWorld(here.R[2]) };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** bearing (0..360, clockwise from true north) and pitch (degrees, up positive) of a direction */
export function headingOf(d: Vec3, ax: Axes): { bearing: number; pitch: number } {
	const len = Math.hypot(...d) || 1;
	const bearing = ((Math.atan2(dot(d, ax.e), dot(d, ax.n)) * 180) / Math.PI + 360) % 360;
	const pitch = (Math.asin(Math.max(-1, Math.min(1, dot(d, ax.u) / len))) * 180) / Math.PI;
	return { bearing, pitch };
}

const WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** the 16-wind name of a bearing: 197.7 -> SSW */
export function windOf(bearing: number): string {
	return WINDS[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16];
}
const CARDINAL: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

export type Tick = { x: number; deg: number; major: boolean; label?: string };

/**
 * Ticks for a tape whose bearing at screen x is known at sample points (x ascending, bearings
 * as measured, wrapping through north as they please). Minor ticks are the finest of 0.1 .. 45
 * degrees at least MINOR_PX apart; labelled ones at least LABEL_PX apart; a cardinal letter
 * wherever one falls, a number elsewhere.
 */
export function headingTicks(xs: number[], bearings: number[]): Tick[] {
	if (xs.length < 2) return [];
	// unwrap, so a view across north is one increasing (or decreasing) run
	const b = [bearings[0]];
	for (let i = 1; i < bearings.length; i++) {
		let d = bearings[i] - bearings[i - 1];
		if (d > 180) d -= 360;
		if (d < -180) d += 360;
		b.push(b[i - 1] + d);
	}
	const span = Math.abs(b[b.length - 1] - b[0]) || 1e-9;
	const ppd = (xs[xs.length - 1] - xs[0]) / span; // pixels per degree, on average
	const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 45, 90];
	const minor = steps.find((s) => s * ppd >= MINOR_PX) ?? 90;
	const label = steps.find((s) => s * ppd >= LABEL_PX && s >= minor) ?? 90;
	const out: Tick[] = [];
	for (let i = 0; i + 1 < b.length; i++) {
		const lo = Math.min(b[i], b[i + 1]), hi = Math.max(b[i], b[i + 1]);
		// half-open [lo, hi), the last interval closed, so a tick on a sample is drawn once
		const last = i + 2 === b.length;
		for (let k = Math.ceil(lo / minor - 1e-9); last ? k * minor <= hi + 1e-9 : k * minor < hi - 1e-9; k++) {
			const deg = k * minor;
			const t = b[i + 1] === b[i] ? 0 : (deg - b[i]) / (b[i + 1] - b[i]);
			const norm = Math.round((((deg % 360) + 360) % 360) * 10) / 10 % 360;
			const isLabel = Math.abs(deg / label - Math.round(deg / label)) < 1e-6;
			const card = CARDINAL[norm];
			out.push({ x: xs[i] + t * (xs[i + 1] - xs[i]), deg: norm, major: isLabel || !!card,
				label: card ?? (isLabel ? fmtDeg(norm, label) : undefined) });
		}
	}
	return out;
}

const MINOR_PX = 7;
const LABEL_PX = 56;

function fmtDeg(d: number, step: number): string {
	return d.toFixed(step < 1 ? 1 : 0);
}

export const TAPE_H = 26;

/** paint the tape across the bottom `TAPE_H` px of a W x H canvas (CSS px), and the centre readout */
export function paintTape(ctx: CanvasRenderingContext2D, W: number, H: number, ticks: Tick[],
	centre: { bearing: number; pitch: number; hfov: number }): void {
	const y0 = H - TAPE_H;
	ctx.save();
	ctx.fillStyle = 'rgba(10,14,20,0.55)';
	ctx.fillRect(0, y0, W, TAPE_H);
	ctx.strokeStyle = 'rgba(230,236,245,0.8)';
	ctx.fillStyle = '#e6ecf5';
	ctx.font = '500 11px system-ui, sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'bottom';
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (const t of ticks) {
		const len = t.major ? 8 : 4;
		ctx.moveTo(Math.round(t.x) + 0.5, y0);
		ctx.lineTo(Math.round(t.x) + 0.5, y0 + len);
	}
	ctx.stroke();
	for (const t of ticks) {
		if (!t.label) continue;
		const card = /^[NSEW]+$/.test(t.label);
		ctx.font = card ? '700 12px system-ui, sans-serif' : '500 11px system-ui, sans-serif';
		ctx.fillStyle = t.label === 'N' ? '#ff8a7a' : card ? '#ffffff' : '#c9d3e0';
		ctx.fillText(t.label, t.x, H - 3);
	}
	// the centre: a marker, and what it points at
	const cx = W / 2;
	ctx.fillStyle = '#ffd34d';
	ctx.beginPath();
	ctx.moveTo(cx - 5, y0 - 1);
	ctx.lineTo(cx + 5, y0 - 1);
	ctx.lineTo(cx, y0 + 6);
	ctx.closePath();
	ctx.fill();
	const fine = centre.hfov < 5;
	const text = `${centre.bearing.toFixed(fine ? 2 : 1)}° ${windOf(centre.bearing)} · pitch ${centre.pitch >= 0 ? '+' : ''}${centre.pitch.toFixed(fine ? 2 : 1)}° · ${centre.hfov < 10 ? centre.hfov.toFixed(2) : centre.hfov.toFixed(0)}° wide`;
	ctx.font = '600 12px system-ui, sans-serif';
	const w = ctx.measureText(text).width + 14;
	ctx.fillStyle = 'rgba(10,14,20,0.75)';
	ctx.fillRect(cx - w / 2, y0 - 22, w, 18);
	ctx.fillStyle = '#ffd34d';
	ctx.textBaseline = 'middle';
	ctx.fillText(text, cx, y0 - 13);
	ctx.restore();
}
