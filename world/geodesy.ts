/**
 * Where a point on the earth IS, in the world frame: WGS84 geodetic -> ECEF -> east/north/up.
 *
 * The browser half of the Python `geodesy.py` (the workbench's enrich/api/app/geodesy.py, moving to
 * the earth service), pinned to it by geodesy-cases.json, which both test against. The world frame
 * is the tangent frame at an origin on the ellipsoid; a solve's own frame is carried into it by
 * the API (`to_world`), so the browser needs this only for things it places by lat/lon itself --
 * terrain tiles, whose heights arrive ellipsoidal so no geoid is needed here.
 *
 * Doubles throughout: a vertex is converted here, relative to a tile's own centre, and only then
 * handed to the GPU as float32 -- small numbers, so float32 is millimetres.
 */
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const RAD = Math.PI / 180;

export type Vec3 = [number, number, number];

export function toEcef(lat: number, lon: number, h: number): Vec3 {
	const la = lat * RAD, lo = lon * RAD;
	const s = Math.sin(la), c = Math.cos(la);
	const n = A / Math.sqrt(1 - E2 * s * s);
	return [(n + h) * c * Math.cos(lo), (n + h) * c * Math.sin(lo), (n * (1 - E2) + h) * s];
}

export function fromEcef(x: number, y: number, z: number): Vec3 {
	const lon = Math.atan2(y, x);
	const p = Math.hypot(x, y);
	let lat = Math.atan2(z, p * (1 - E2));
	let h = 0;
	for (let i = 0; i < 5; i++) {
		const s = Math.sin(lat);
		const n = A / Math.sqrt(1 - E2 * s * s);
		h = p / Math.cos(lat) - n;
		lat = Math.atan2(z, p * (1 - E2 * n / (n + h)));
	}
	const s = Math.sin(lat);
	h = p / Math.cos(lat) - A / Math.sqrt(1 - E2 * s * s);
	return [lat / RAD, lon / RAD, h];
}

/** The tangent frame at (lat, lon, h): ENU metres, h ellipsoidal. */
export class Frame {
	readonly o: Vec3;
	/** rows east, north, up, in ECEF */
	readonly R: [Vec3, Vec3, Vec3];
	constructor(readonly lat: number, readonly lon: number, readonly h = 0) {
		const la = lat * RAD, lo = lon * RAD;
		const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
		this.R = [[-so, co, 0], [-sl * co, -sl * so, cl], [cl * co, cl * so, sl]];
		this.o = toEcef(lat, lon, h);
	}

	fromGeodetic(lat: number, lon: number, h: number): Vec3 {
		const p = toEcef(lat, lon, h);
		const d = [p[0] - this.o[0], p[1] - this.o[1], p[2] - this.o[2]];
		const R = this.R;
		return [R[0][0] * d[0] + R[0][1] * d[1] + R[0][2] * d[2],
			R[1][0] * d[0] + R[1][1] * d[1] + R[1][2] * d[2],
			R[2][0] * d[0] + R[2][1] * d[1] + R[2][2] * d[2]];
	}

	toGeodetic(e: number, n: number, u: number): Vec3 {
		const R = this.R;
		return fromEcef(R[0][0] * e + R[1][0] * n + R[2][0] * u + this.o[0],
			R[0][1] * e + R[1][1] * n + R[2][1] * u + this.o[1],
			R[0][2] * e + R[1][2] * n + R[2][2] * u + this.o[2]);
	}

	/** this frame's up, in `other`'s ENU: what "vertical" means at this spot, seen from there */
	upIn(other: Frame): Vec3 {
		const u = this.R[2], R = other.R;
		return [R[0][0] * u[0] + R[0][1] * u[1] + R[0][2] * u[2],
			R[1][0] * u[0] + R[1][1] * u[1] + R[1][2] * u[2],
			R[2][0] * u[0] + R[2][1] * u[1] + R[2][2] * u[2]];
	}
}

/** The 4x4 (row-major) that carries `local` ENU coordinates into `world` ENU, p_w = M p: the TS half of
 * geodesy.py's rigid(), the same rotation R_w R_l^T and translation R_w (o_l - o_w). */
export function rigid(local: Frame, world: Frame): number[] {
	const L = local.R, W = world.R;
	const d = [local.o[0] - world.o[0], local.o[1] - world.o[1], local.o[2] - world.o[2]];
	const M: number[] = [];
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) M.push(W[i][0] * L[j][0] + W[i][1] * L[j][1] + W[i][2] * L[j][2]);
		M.push(W[i][0] * d[0] + W[i][1] * d[1] + W[i][2] * d[2]);
	}
	M.push(0, 0, 0, 1);
	return M;
}
