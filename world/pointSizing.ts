/**
 * A point's size by its distance from the eye (the operator, 2026-11-21: far points "at least 4px when far, then make
 * them smaller as they approach"; "we will experiment"). On screen a point is `nearPx` at the eye, rising smoothly to
 * `farPx` at `kneeM` and `farPx` beyond, in CSS px. Near, where a cloud is densest, its points stay small and its
 * detail crisp; far, where only its coarse levels are held, they stay large enough to fill the gaps between them.
 *
 * sizeByDistance puts the curve into a three PointsMaterial's own shader, so every viewer's points can take it; a new
 * curve changes its uniforms only. sizeInMetres turns the same material back to a size in metres (three's own rule,
 * attenuated), for a viewer that offers both. pointPxAt is the curve on the CPU, for a readout.
 */
import type * as THREE_NS from 'three';

export type PointSizing = { nearPx: number; farPx: number; kneeM: number };

/** the ranges a viewer offers, and the first choice */
export const POINT_SIZING = {
	nearPx: { min: 0.5, max: 10, step: 0.5, initial: 9 },
	farPx: { min: 1, max: 16, step: 0.5, initial: 1 },
	kneeM: { min: 5, max: 2000, step: 5, initial: 10 }
} as const;

export function initialPointSizing(): PointSizing {
	return { nearPx: POINT_SIZING.nearPx.initial, farPx: POINT_SIZING.farPx.initial, kneeM: POINT_SIZING.kneeM.initial };
}

/** a saved sizing, field by field: a value missing or off its range takes its initial one */
export function readPointSizing(v: unknown): PointSizing {
	const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
	const pick = (k: keyof PointSizing) => {
		const x = o[k], r = POINT_SIZING[k];
		return typeof x === 'number' && x >= r.min && x <= r.max ? x : r.initial;
	};
	return { nearPx: pick('nearPx'), farPx: pick('farPx'), kneeM: pick('kneeM') };
}

function checked(s: PointSizing): PointSizing {
	for (const k of ['nearPx', 'farPx', 'kneeM'] as const)
		if (!Number.isFinite(s[k]) || s[k] <= 0) throw new Error(`points: a ${k} of ${s[k]}`);
	return s;
}

/** the curve, as the shader draws it: CSS px at `d` metres from the eye */
export function pointPxAt(s: PointSizing, d: number): number {
	const t = Math.min(1, Math.max(0, d / s.kneeM));
	return s.nearPx + (s.farPx - s.nearPx) * t * t * (3 - 2 * t);
}

const SIZE_LINE = 'gl_PointSize = size;';
type Uniforms = { uNearPx: { value: number }; uFarPx: { value: number }; uKneeM: { value: number };
	/** 1: the curve; 0: three's own size, in metres when attenuated */
	uByDistance: { value: number } };

/** the patch, once per material: the curve's uniforms and the shader line that reads them */
function patched(material: THREE_NS.PointsMaterial): Uniforms {
	const have = material.userData.pointSizing as Uniforms | undefined;
	if (have) return have;
	const u: Uniforms = { uNearPx: { value: 1 }, uFarPx: { value: 1 }, uKneeM: { value: 1 }, uByDistance: { value: 0 } };
	material.userData.pointSizing = u;
	const before = material.onBeforeCompile, prior = material.customProgramCacheKey();
	material.onBeforeCompile = (shader, renderer) => {
		before.call(material, shader, renderer);
		if (!shader.vertexShader.includes(SIZE_LINE)) throw new Error(`three changed its point shader: no "${SIZE_LINE}"`);
		Object.assign(shader.uniforms, u);
		shader.vertexShader = 'uniform float uNearPx;\nuniform float uFarPx;\nuniform float uKneeM;\nuniform float uByDistance;\n' +
			shader.vertexShader.replace(SIZE_LINE, 'gl_PointSize = uByDistance > 0.5\n' +
				'\t\t? size * mix(uNearPx, uFarPx, smoothstep(0.0, uKneeM, length(mvPosition.xyz))) : size;');
	};
	material.customProgramCacheKey = () => `${prior}+point-sizing`;
	material.needsUpdate = true;
	return u;
}

/** a change of attenuation is a define, so a new program; the curve and the metres are uniforms */
function attenuate(material: THREE_NS.PointsMaterial, on: boolean) {
	if (material.sizeAttenuation === on) return;
	material.sizeAttenuation = on;
	material.needsUpdate = true;
}

/**
 * `material`'s points sized by distance, by `sizing`'s curve. Its own `size` is held at 1, so three's `size` uniform is
 * the pixel ratio and the curve comes out in CSS px; attenuation is off, the curve being the whole rule. The patch
 * composes with an onBeforeCompile already set (the sRGB colour patch, a viewer's filters) and keys its program apart;
 * after the first call a new curve changes uniforms only.
 */
export function sizeByDistance(material: THREE_NS.PointsMaterial, sizing: PointSizing): void {
	const s = checked(sizing), u = patched(material);
	u.uNearPx.value = s.nearPx;
	u.uFarPx.value = s.farPx;
	u.uKneeM.value = s.kneeM;
	u.uByDistance.value = 1;
	material.size = 1;
	attenuate(material, false);
}

/** `material`'s points `metres` across in the world, as three draws them (attenuated): the other rule a viewer offers */
export function sizeInMetres(material: THREE_NS.PointsMaterial, metres: number): void {
	// 0 draws nothing, as three's own size does (a viewer's size before its cloud's spacing is known)
	if (!Number.isFinite(metres) || metres < 0) throw new Error(`points: a size of ${metres} m`);
	patched(material).uByDistance.value = 0;
	material.size = metres;
	attenuate(material, true);
}
