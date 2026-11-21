import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { srgbPointsMaterial } from './blockCloud';
import { POINT_SIZING, initialPointSizing, pointPxAt, readPointSizing, sizeByDistance, sizeInMetres } from './pointSizing';

/** what three hands a material's onBeforeCompile for points: its own shader source and uniforms */
const pointsShader = () => ({
	uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.points.uniforms) as Record<string, { value: unknown }>,
	vertexShader: THREE.ShaderLib.points.vertexShader, fragmentShader: THREE.ShaderLib.points.fragmentShader
});
const compile = (m: THREE.PointsMaterial) => {
	const shader = pointsShader();
	// the renderer is three's to pass; neither patch reads it
	m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as never);
	return shader;
};

describe('point size by distance', () => {
	test('small by the eye, rising smoothly to the far size at the knee, and the far size beyond', () => {
		const s = { nearPx: 1.5, farPx: 4, kneeM: 100 };
		expect(pointPxAt(s, 0)).toBe(1.5);
		expect(pointPxAt(s, 50)).toBeCloseTo(2.75, 9);
		expect([100, 400, 1e6].map((d) => pointPxAt(s, d))).toEqual([4, 4, 4]);
		const curve = Array.from({ length: 101 }, (_, i) => pointPxAt(s, i));
		for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
		// flat at both ends, as smoothstep is: the first and last metre move it least
		expect(curve[1] - curve[0]).toBeLessThan(curve[51] - curve[50]);
		expect(curve[100] - curve[99]).toBeLessThan(curve[51] - curve[50]);
	});

	test("a material's shader takes the curve, composed with its sRGB patch, in its own program", () => {
		const plain = srgbPointsMaterial(THREE), m = srgbPointsMaterial(THREE);
		sizeByDistance(m, { nearPx: 1.5, farPx: 4, kneeM: 100 });
		expect([m.size, m.sizeAttenuation]).toEqual([1, false]);
		expect(m.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
		const shader = compile(m);
		expect(shader.vertexShader).toContain('gl_PointSize = uByDistance > 0.5\n\t\t? size * mix(uNearPx, uFarPx, smoothstep(0.0, uKneeM, length(mvPosition.xyz))) : size;');
		expect(shader.vertexShader).not.toContain('gl_PointSize = size;');
		expect(shader.vertexShader).toContain('pow((vColor.rgb + 0.055) / 1.055');      // the sRGB patch is still there
		const read = () => ['uNearPx', 'uFarPx', 'uKneeM', 'uByDistance'].map((k) => shader.uniforms[k].value);
		expect(read()).toEqual([1.5, 4, 100, 1]);
		// another curve: the same uniform objects the program holds, the same program
		const key = m.customProgramCacheKey(), version = m.version;
		sizeByDistance(m, { nearPx: 1, farPx: 8, kneeM: 300 });
		expect(read()).toEqual([1, 8, 300, 1]);
		expect([m.customProgramCacheKey(), m.version]).toEqual([key, version]);
	});

	test('one material switches between the curve and metres: the patch once, a new program only for attenuation', () => {
		const m = srgbPointsMaterial(THREE);
		sizeInMetres(m, 0.2);
		const shader = compile(m), u = m.userData.pointSizing;
		expect([m.size, m.sizeAttenuation, u.uByDistance.value]).toEqual([0.2, true, 0]);
		let version = m.version;
		sizeInMetres(m, 0.5);                                   // another size in metres: a uniform, the same program
		expect([m.size, m.version]).toEqual([0.5, version]);
		sizeByDistance(m, initialPointSizing());               // attenuation off: a define, so the program is built again
		expect([m.size, m.sizeAttenuation, u.uByDistance.value]).toEqual([1, false, 1]);
		expect(m.version).toBeGreaterThan(version);
		version = m.version;
		sizeInMetres(m, 0.5);
		expect([m.size, m.sizeAttenuation, u.uByDistance.value, m.userData.pointSizing]).toEqual([0.5, true, 0, u]);
		expect(m.version).toBeGreaterThan(version);
		// the patch went in once: the shader handed to it has the line once
		expect(shader.vertexShader.split('uByDistance > 0.5').length).toBe(2);
	});

	test('refused: a curve or a size that is none, leaving the material as it was', () => {
		const m = srgbPointsMaterial(THREE);
		sizeByDistance(m, initialPointSizing());
		for (const bad of [{ nearPx: 0 }, { farPx: -1 }, { kneeM: NaN }, { kneeM: Infinity }])
			expect(() => sizeByDistance(m, { ...initialPointSizing(), ...bad })).toThrow('points: a');
		for (const bad of [-1, NaN, Infinity]) expect(() => sizeInMetres(m, bad)).toThrow('points: a size');
		expect([m.userData.pointSizing.uNearPx.value, m.userData.pointSizing.uByDistance.value]).toEqual([POINT_SIZING.nearPx.initial, 1]);
	});

	test('a saved curve is read field by field: one off its range takes its initial value, the others stay', () => {
		expect(readPointSizing({ nearPx: 2, farPx: 6, kneeM: 50 })).toEqual({ nearPx: 2, farPx: 6, kneeM: 50 });
		expect(readPointSizing({ nearPx: 0.1, farPx: 6, kneeM: 1e5 })).toEqual({ nearPx: 1.5, farPx: 6, kneeM: 100 });
		for (const v of [null, 'x', 7, {}]) expect(readPointSizing(v)).toEqual(initialPointSizing());
	});
});
