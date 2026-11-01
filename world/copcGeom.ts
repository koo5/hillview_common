/**
 * The geometry a COPC query needs, with no COPC in it.
 *
 * Split out of copcSource.ts so it can be unit tested: that module imports laz-perf's .wasm
 * through vite's `?url`, which only a vite build can resolve, so `bun test` cannot load it at
 * all. Everything here is arithmetic over plain numbers, and it is the part most worth pinning
 * — a transposed rotation or a dropped scale still selects a plausible-looking sheet of nodes,
 * so the failure arrives as a slightly wrong picture rather than an error.
 */

/** p_enu = scale · (R · p) + t — the run's similarity onto east/north/up metres. */
export type EnuAlignment = { scale: number; R: number[][]; t: number[] };

/** Every point with |p·n + d| <= half, in the COPC's own (solve) coordinates. */
export type Slab = { n: [number, number, number]; d: number; half: number };

/** Does [minx,miny,minz,maxx,maxy,maxz] a overlap b? Touching counts — a section plane
 *  lying exactly on a node boundary must not silently drop that node. */
export function overlaps(a: number[], b: number[]): boolean {
	return a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2];
}

/**
 * Does an octree node's cube touch the slab?
 *
 * This is here because the viewer's SECTION is a slab, and a slab is the one shape an
 * axis-aligned box cannot express: a thin cut across a walk that does not run along an axis
 * has the entire scene as its bounding box, so an AABB query would prune nothing and the
 * octree would still only be doing level-of-detail. Cube-against-slab costs three multiplies
 * and leaves a sheet of nodes for a 0.35 m cut through a 40 m scene.
 *
 * Conservative on purpose: a node is kept when its cube touches the slab at all, so it can
 * never drop a point the exact per-point test would have kept.
 */
export function slabHitsBox(s: Slab, b: number[]): boolean {
	const mx = (b[0] + b[3]) / 2, my = (b[1] + b[4]) / 2, mz = (b[2] + b[5]) / 2;
	const ex = (b[3] - b[0]) / 2, ey = (b[4] - b[1]) / 2, ez = (b[5] - b[2]) / 2;
	const dist = Math.abs(mx * s.n[0] + my * s.n[1] + mz * s.n[2] + s.d);
	// the box's own extent measured along the plane normal
	const reach = ex * Math.abs(s.n[0]) + ey * Math.abs(s.n[1]) + ez * Math.abs(s.n[2]);
	return dist <= reach + s.half;
}

/**
 * The viewer's section plane, expressed in the FILE's coordinates.
 *
 * The viewer works in ENU metres; the COPC holds the solve's own frame with the similarity
 * p_enu = s·(R·p) + t. Substituting into |(p_enu − c)·n| ≤ half and collecting terms:
 *
 *     (s·R·p + t − c)·n  =  p·(s·Rᵀn)  +  (t − c)·n
 *
 * so the plane carries across as n' = s·Rᵀn and d = (t − c)·n, with the half-thickness
 * unchanged in metres because the scale is already folded into n'. Passing the ENU plane
 * straight through instead would select a sheet at the wrong angle, which still looks like a
 * section of something — the failure would not announce itself.
 */
export function slabInFileFrame(
	enu: EnuAlignment | null,
	centreEnu: [number, number, number],
	normalEnu: [number, number, number],
	half: number
): Slab {
	if (!enu) {
		const d = -(centreEnu[0] * normalEnu[0] + centreEnu[1] * normalEnu[1] + centreEnu[2] * normalEnu[2]);
		return { n: normalEnu, d, half };
	}
	const { R, t, scale } = enu;
	// Rᵀn — the transpose, so the sum runs down the column
	const n: [number, number, number] = [
		scale * (R[0][0] * normalEnu[0] + R[1][0] * normalEnu[1] + R[2][0] * normalEnu[2]),
		scale * (R[0][1] * normalEnu[0] + R[1][1] * normalEnu[1] + R[2][1] * normalEnu[2]),
		scale * (R[0][2] * normalEnu[0] + R[1][2] * normalEnu[1] + R[2][2] * normalEnu[2])
	];
	const d =
		(t[0] - centreEnu[0]) * normalEnu[0] +
		(t[1] - centreEnu[1]) * normalEnu[1] +
		(t[2] - centreEnu[2]) * normalEnu[2];
	return { n, d, half };
}
