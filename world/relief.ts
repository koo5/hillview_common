/**
 * Relief (2026-09-30): height exaggeration and atmospheric refraction, as the scene's vertex
 * shader draws them and as the CPU must mirror them -- a name's anchor (worldLabels.project) and a
 * click on the picture (worldPick) both have to know where a point was DRAWN. The shader chunk
 * and its CPU mirror live here together, and the tests pin the one to the other.
 *
 * - EXAGGERATION stretches the height above the curved ground's tangent plane (d^2 / 2R put
 *   back) by `exag`, about the reference height `ref`.
 * - REFRACTION, as a coefficient k = R / (radius of the light path): a ray bends with the earth,
 *   so far ground APPEARS higher by k d^2 / 2R, d from the OBSERVER. Textbook k = 0.13; over
 *   water and under inversions anything from below 0 to well past 0.3.
 *
 * Scene coordinates are a local tangent frame, z up. Identity at exag 1, k 0.
 */
import type { Vec3 } from './geodesy';

const R_EARTH_M = 6_371_000;

/** the uniforms RELIEF_CHUNK reads; prepend to a vertex shader */
export const RELIEF_DECL = 'uniform float uExag;\nuniform vec3 uExagOrigin;\nuniform float uExagRef;\nuniform float uRefK;\n';

/** replaces three's `#include <project_vertex>`: the vertex, relieved, into clip space */
export const RELIEF_CHUNK = `
	vec4 mvPosition = vec4( transformed, 1.0 );
	if ( uExag != 1.0 || uRefK != 0.0 ) {
		vec4 wp = modelMatrix * mvPosition;
		vec3 rel = wp.xyz - uExagOrigin;
		// height above the curved ground's tangent plane, then stretched: d^2 / 2R put back
		float drop = dot( rel.xy, rel.xy ) / ( 2.0 * 6371000.0 );
		wp.z += ( uExag - 1.0 ) * ( rel.z + drop - uExagRef );
		// refraction lifts what is far FROM THE CAMERA (cameraPosition, three's own uniform)
		vec2 fromCam = wp.xy - cameraPosition.xy;
		wp.z += uRefK * dot( fromCam, fromCam ) / ( 2.0 * 6371000.0 );
		mvPosition = viewMatrix * wp;
	} else {
		mvPosition = modelViewMatrix * mvPosition;
	}
	gl_Position = projectionMatrix * mvPosition;
`;

export type Relief = { exag: number; k: number; origin: Vec3; ref: number };

/**
 * Where RELIEF_CHUNK draws a scene point, on the CPU:
 * the height above the curved ground's tangent plane stretched by `exag` about `ref`, then the
 * refraction lift k d^2 / 2R with d from the CAMERA. Identity at exag 1, k 0.
 */
export function relieved(s: Vec3, cam: Vec3, r: Relief | null): Vec3 {
	if (!r || (r.exag === 1 && r.k === 0)) return s;
	const rx = s[0] - r.origin[0], ry = s[1] - r.origin[1], rz = s[2] - r.origin[2];
	let z = s[2] + (r.exag - 1) * (rz + (rx * rx + ry * ry) / (2 * R_EARTH_M) - r.ref);
	const fx = s[0] - cam[0], fy = s[1] - cam[1];
	z += (r.k * (fx * fx + fy * fy)) / (2 * R_EARTH_M);
	return [s[0], s[1], z];
}

/** `relieved` undone: the scene point whose drawn image is `p` (a depth pick lands on what was
 * DRAWN, the stretched and lifted surface). Only z moves, so it is one division. */
export function unrelieved(p: Vec3, cam: Vec3, r: Relief | null): Vec3 {
	if (!r || (r.exag === 1 && r.k === 0)) return p;
	const rx = p[0] - r.origin[0], ry = p[1] - r.origin[1];
	const fx = p[0] - cam[0], fy = p[1] - cam[1];
	const lifted = p[2] - (r.k * (fx * fx + fy * fy)) / (2 * R_EARTH_M);
	// lifted = z + (exag - 1)(z - origin_z + curv - ref)  =>  z = (lifted + (exag - 1)(origin_z - curv + ref)) / exag
	const curv = (rx * rx + ry * ry) / (2 * R_EARTH_M);
	return [p[0], p[1], (lifted + (r.exag - 1) * (r.origin[2] - curv + r.ref)) / r.exag];
}

