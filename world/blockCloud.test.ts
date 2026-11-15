import * as THREE from 'three';
import { expect, test } from 'vitest';
import { BlockCloud, blockBytes, srgbPointsMaterial, type BlockRows } from './blockCloud';

const block = (n: number, at = 0): BlockRows => ({
	positions: Float32Array.from({ length: n * 3 }, (_, i) => at + i),
	colors: Uint8Array.from({ length: n * 3 }, (_, i) => i % 256)
});
const drawnRows = (c: { object: THREE.Group }) =>
	c.object.children.map((p) => ((p as THREE.Points).geometry.getAttribute('position').array as Float32Array));
type Sourced = BlockRows & { views: Uint16Array };
const sourced = (n: number, at = 0): Sourced => ({ ...block(n, at), views: Uint16Array.from({ length: n }, (_, i) => i % 3) });

test('extra attributes join with the block, on its own arrays, and count in the frame\'s upload (RECON-UI\'s ui13)', () => {
	const a = sourced(10), b = sourced(10, 100);
	const c = new BlockCloud<Sourced>(THREE, {
		attributes: (rows) => ({ source: new THREE.BufferAttribute(rows.views, 1) }),
		// a's position and colour bytes fit, its source ids do not: the cap counts them, so b waits a frame
		uploadBytes: blockBytes(a) + blockBytes(b)
	});
	c.sync([a, b]);
	expect([c.step(), c.waitingBlocks]).toEqual([true, 1]);
	const g = (c.object.children[0] as THREE.Points).geometry;
	expect(g.getAttribute('source').array).toBe(a.views);
	expect(c.step()).toBe(false);
	expect([...c.drawnBlocks()].map(([rows, p]) => [rows, (p as THREE.Points).geometry.getAttribute('source').array]))
		.toEqual([[a, a.views], [b, b.views]]);
});

test('an extra attribute of the wrong length, or named like a drawn one, is refused', () => {
	const short = new BlockCloud<Sourced>(THREE, { attributes: (rows) => ({ source: new THREE.BufferAttribute(rows.views.subarray(1), 1) }) });
	short.sync([sourced(4)]);
	expect(() => short.step()).toThrow('source has 3 rows for 4 points');
	const clash = new BlockCloud<Sourced>(THREE, { attributes: (rows) => ({ color: new THREE.BufferAttribute(rows.views, 1) }) });
	clash.sync([sourced(4)]);
	expect(() => clash.step()).toThrow('cannot be named color');
});

test('drawnBlocks: the joined blocks in join order, without empty, waiting or dropped ones', () => {
	const a = block(2), empty = block(0), b = block(2, 10), late = block(2, 20);
	const c = new BlockCloud(THREE, { uploadBytes: blockBytes(a) + blockBytes(b) });
	c.sync([a, empty, b, late]);
	c.step();
	expect([...c.drawnBlocks()].map(([rows]) => rows)).toEqual([a, b]);
	c.sync([b, late, a]);
	c.step();
	expect([...c.drawnBlocks()].map(([rows]) => rows)).toEqual([a, b, late]);
	c.sync([late]);
	expect([...c.drawnBlocks()].map(([rows]) => rows)).toEqual([late]);
	// a block let go and held again joins anew: last in join order
	c.sync([late, a]);
	c.step();
	expect([...c.drawnBlocks()].map(([rows]) => rows)).toEqual([late, a]);
});

test('a block joins unculled until its first render (its upload is that frame\'s); culling off draws every block', () => {
	const c = new BlockCloud(THREE), a = block(2), b = block(2, 10);
	const pointsOf = (rows: BlockRows) => [...c.drawnBlocks()].find(([r]) => r === rows)![1];
	// three calls onAfterRender after it drew the object; here, by hand
	const render = (p: THREE.Points) => p.onAfterRender({} as THREE.WebGLRenderer, {} as THREE.Scene, {} as THREE.Camera,
		p.geometry, p.material as THREE.Material, null as unknown as THREE.Group);
	c.sync([a]);
	c.step();
	expect(pointsOf(a).frustumCulled).toBe(false);
	render(pointsOf(a));
	expect(pointsOf(a).frustumCulled).toBe(true);
	// a relief that moves points off their spheres: every block drawn, a fresh one too, and it stays so once rendered
	c.culling = false;
	expect(pointsOf(a).frustumCulled).toBe(false);
	c.sync([a, b]);
	c.step();
	render(pointsOf(b));
	expect([c.culling, pointsOf(b).frustumCulled]).toEqual([false, false]);
	// culling back on: the rendered blocks are culled, one not rendered yet waits for its render
	const late = block(2, 20);
	c.sync([a, b, late]);
	c.step();
	c.culling = true;
	expect([pointsOf(a).frustumCulled, pointsOf(b).frustumCulled, pointsOf(late).frustumCulled]).toEqual([true, true, false]);
	render(pointsOf(late));
	render(pointsOf(late));                                   // a second pass in the same frame changes nothing
	expect(pointsOf(late).frustumCulled).toBe(true);
});

test('a block is drawn on its own arrays, colour bytes normalized, nothing copied', () => {
	const c = new BlockCloud(THREE), a = block(4);
	c.sync([a]);
	expect(c.step()).toBe(false);
	const g = (c.object.children[0] as THREE.Points).geometry;
	expect(g.getAttribute('position').array).toBe(a.positions);
	const colour = g.getAttribute('color') as THREE.BufferAttribute;
	expect([colour.array === a.colors, colour.normalized, colour.itemSize]).toEqual([true, true, 3]);
	expect(g.boundingSphere).not.toBeNull();
	expect((c.object.children[0] as THREE.Points).material).toBe(c.material);
	expect(c.points).toBe(4);
});

test('waiting blocks join nearest first, at most the upload a frame, and at least one however large', () => {
	const a = block(10), b = block(10, 100), big = block(50, 200), d = block(1, 900);
	const c = new BlockCloud(THREE, { uploadBytes: blockBytes(a) + blockBytes(b) });
	c.sync([a, b, big, d]);
	expect([c.step(), c.waitingBlocks]).toEqual([true, 2]);
	expect(drawnRows(c)).toEqual([a.positions, b.positions]);
	// the big block alone is over the cap: it still joins, by itself
	expect([c.step(), c.waitingBlocks]).toEqual([true, 1]);
	expect([c.step(), c.waitingBlocks]).toEqual([false, 0]);
	expect(c.points).toBe(71);
});

test('a block the residency lets go leaves at once and frees its buffers; one that never joined never draws', () => {
	const a = block(3), b = block(3, 10), late = block(3, 20);
	const c = new BlockCloud(THREE, { uploadBytes: 1 });
	c.sync([a, b, late]);
	c.step(); c.step();
	let freed = 0;
	(c.object.children[0] as THREE.Points).geometry.addEventListener('dispose', () => freed++);
	c.sync([b]);
	expect([freed, drawnRows(c), c.waitingBlocks]).toEqual([1, [b.positions], 0]);
	expect(c.step()).toBe(false);
	expect(drawnRows(c)).toEqual([b.positions]);
	// held again later (a new view wants it back): a new join, nothing kept from before
	c.sync([b, a]);
	c.step();
	expect(drawnRows(c)).toEqual([b.positions, a.positions]);
});

test('an empty block (a dense view of sparse-only rows) holds its place and draws nothing', () => {
	const c = new BlockCloud(THREE), empty = block(0);
	c.sync([empty, block(2)]);
	expect(c.step()).toBe(false);
	expect([c.object.children.length, c.waitingBlocks, c.points]).toEqual([1, 0, 2]);
	c.sync([empty]);
	expect(c.object.children.length).toBe(0);
});

test('a block whose colours do not match its positions is refused', () => {
	const c = new BlockCloud(THREE);
	c.sync([{ positions: new Float32Array(6), colors: new Uint8Array(3) }]);
	expect(() => c.step()).toThrow('three colour bytes');
	expect(() => new BlockCloud(THREE, { uploadBytes: 0 })).toThrow('positive');
});

test('dispose frees every block; a caller\'s material stays the caller\'s', () => {
	const own = srgbPointsMaterial(THREE, { size: 3 });
	let materialFreed = 0;
	own.addEventListener('dispose', () => materialFreed++);
	const c = new BlockCloud(THREE, { material: own });
	c.sync([block(2), block(2, 10)]);
	c.step();
	let freed = 0;
	for (const p of c.object.children) (p as THREE.Points).geometry.addEventListener('dispose', () => freed++);
	c.dispose();
	expect([freed, c.object.children.length, materialFreed]).toEqual([2, 0, 0]);
});

test('the shader decodes sRGB bytes with the IEC 61966-2-1 curve', () => {
	const m = srgbPointsMaterial(THREE, { size: 2, sizeAttenuation: false });
	expect([m.vertexColors, m.size, m.sizeAttenuation]).toEqual([true, 2, false]);
	const shader = { vertexShader: THREE.ShaderLib.points.vertexShader, fragmentShader: '', uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
	m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
	expect(shader.vertexShader).toContain('#include <color_vertex>\n#ifdef USE_COLOR\n\tvColor.rgb = mix(vColor.rgb / 12.92');
	expect(shader.vertexShader).toContain('step(vec3(0.04045), vColor.rgb)');
	expect(m.customProgramCacheKey()).toBe('srgb-bytes-points');
	const broken = { vertexShader: 'void main(){}', fragmentShader: '', uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
	expect(() => m.onBeforeCompile(broken, {} as THREE.WebGLRenderer)).toThrow('color_vertex');
});
