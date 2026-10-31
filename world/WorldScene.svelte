<script lang="ts">
	/**
	 * The 3D world as an observer standing at a point (ea05): earth's terrain round them, its
	 * orthophoto draped on it, looking along a bearing. The lean core both apps mount; each app's
	 * own panel round it decides where the observer stands and what a turn of the view writes back.
	 *
	 * Position and bearing are props (the app's one location state); a drag turns the view and says
	 * so through `onlook`, the wheel or a pinch raises the eye. Nothing is drawn but on a change: a
	 * moved view, a loaded tile, a resize.
	 */
	import { onDestroy, onMount } from 'svelte';
	import type * as THREE_NS from 'three';
	import { Frame, type Vec3 } from './geodesy';
	import { loadEarth, type Credit, type TerrainModel } from './earth';
	import { TerrainTiles, horizonM } from './terrainTiles';
	import { createWorldRenderer, type DepthMode } from './renderer';
	import { ViewGate, cameraView } from './view';

	type Props = {
		/** the earth service's base URL */
		earthUrl: string;
		channel?: string;
		model?: TerrainModel;
		lat: number;
		lon: number;
		/** degrees clockwise from north */
		bearing: number;
		/** degrees above the horizon */
		pitch?: number;
		/** the eye above the ground, metres */
		eyeM?: number;
		fovY?: number;
		/** a drag turned the view: the bearing and pitch now shown */
		onlook?: (look: { bearing: number; pitch: number }) => void;
		oneye?: (eyeM: number) => void;
		testid?: string;
	};
	let {
		earthUrl, channel = 'prod', model = 'surface', lat, lon, bearing, pitch = -5, eyeM = 2, fovY = 55,
		onlook, oneye, testid = 'world-scene'
	}: Props = $props();

	/** a frame is good for this far from its origin; past it the scene is laid out again */
	const REFRAME_M = 20_000;
	const MIN_EYE_M = 1.5, MAX_EYE_M = 20_000;

	let host: HTMLDivElement;
	let error = $state<string | null>(null);
	let credits = $state<Credit[]>([]);
	let loading = $state(true);

	let three: typeof THREE_NS | null = null;
	let renderer: THREE_NS.WebGLRenderer | null = null;
	let scene: THREE_NS.Scene | null = null;
	let camera: THREE_NS.PerspectiveCamera | null = null;
	let terrain: TerrainTiles | null = null;
	let frame: Frame | null = null;
	let layers: Awaited<ReturnType<typeof loadEarth>> | null = null;
	let ground: number | null = null;
	let depthMode = $state<DepthMode | null>(null);
	const gate = new ViewGate();
	let scratch: THREE_NS.Vector3 | null = null;
	let raf = 0;
	let retry: ReturnType<typeof setTimeout> | 0 = 0;
	let destroyed = false;
	const abort = new AbortController();

	/** the view direction in a z-up ENU frame */
	function direction(b: number, p: number): Vec3 {
		const br = (b * Math.PI) / 180, pr = (p * Math.PI) / 180;
		return [Math.sin(br) * Math.cos(pr), Math.cos(br) * Math.cos(pr), Math.sin(pr)];
	}

	function ensureFrame() {
		if (!three || !scene || !layers) return;
		if (frame) {
			const [e, n] = frame.fromGeodetic(lat, lon, 0);
			if (Math.hypot(e, n) < REFRAME_M) return;
		}
		terrain?.dispose();
		if (terrain) scene.remove(terrain.group);
		frame = new Frame(lat, lon, 0);
		ground = null;
		terrain = new TerrainTiles(three, {
			tileUrl: layers.tileUrl, orthoUrl: layers.orthoUrl, frame,
			// what is loaded says where the ground is, and so what is in view: choose again
			onChange: () => { gate.reset(); draw(); }
		});
		gate.reset();
		scene.add(terrain.group);
	}

	function render() {
		raf = 0;
		if (!renderer || !scene || !camera || !frame || !terrain) return;
		ground = terrain.heightAt(lat, lon) ?? ground;
		const h = (ground ?? 0) + eyeM;
		const cam = frame.fromGeodetic(lat, lon, h);
		const d = direction(bearing, pitch);
		camera.position.set(...cam);
		camera.up.set(0, 0, 1);
		camera.lookAt(cam[0] + d[0], cam[1] + d[1], cam[2] + d[2]);
		camera.fov = fovY;
		camera.near = depthMode === 'reversed' ? 0.05 : 0.5;
		camera.far = Math.max(5_000, horizonM(eyeM) * 1.5 + 50_000);
		camera.updateProjectionMatrix();
		const v = cameraView(camera, scratch!, host.clientHeight || 800);
		const ask = gate.state(cam, v, performance.now());
		if (ask === 'due') terrain.update(cam, v);
		// drawn only on change: a view the gate held back is asked for once its interval is up
		else if (ask === 'soon' && !retry) retry = setTimeout(() => { retry = 0; draw(); }, gate.interval);
		renderer.render(scene, camera);
	}

	/** ask for one frame; many asks before it lands are one frame */
	function draw() {
		if (!raf && !destroyed) raf = requestAnimationFrame(render);
	}

	// a move of the observer (the app's location state) or of the view
	$effect(() => {
		void lat; void lon; void bearing; void pitch; void eyeM; void fovY;
		ensureFrame();
		draw();
	});

	function resize() {
		if (!renderer || !camera || !host) return;
		const w = host.clientWidth, h = host.clientHeight;
		if (!w || !h) return;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		draw();
	}

	// ---- input: drag to look, wheel or pinch to raise the eye ----
	const pointers = new Map<number, { x: number; y: number }>();
	let pinch: number | null = null;

	function degPerPx() {
		return fovY / Math.max(1, host.clientHeight);
	}
	function onpointerdown(e: PointerEvent) {
		host.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		pinch = null;
	}
	function onpointermove(e: PointerEvent) {
		const last = pointers.get(e.pointerId);
		if (!last) return;
		if (pointers.size === 2) {
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			const [a, b] = [...pointers.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (pinch !== null && d > 0) raise(pinch / d);
			pinch = d;
			return;
		}
		const k = degPerPx();
		const nb = (((bearing - (e.clientX - last.x) * k) % 360) + 360) % 360;
		const np = Math.max(-89, Math.min(89, pitch + (e.clientY - last.y) * k));
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		onlook?.({ bearing: nb, pitch: np });
	}
	function onpointerup(e: PointerEvent) {
		pointers.delete(e.pointerId);
		pinch = null;
	}
	function raise(factor: number) {
		const next = Math.max(MIN_EYE_M, Math.min(MAX_EYE_M, eyeM * factor));
		if (next !== eyeM) oneye?.(next);
	}
	function onwheel(e: WheelEvent) {
		e.preventDefault();
		raise(Math.exp(e.deltaY * 0.002));
	}

	let observer: ResizeObserver | null = null;
	onMount(async () => {
		try {
			const [THREE, earth] = await Promise.all([import('three'), loadEarth(earthUrl, channel, { model, signal: abort.signal })]);
			if (destroyed) return;
			three = THREE;
			layers = earth;
			credits = earth.credits;
			({ renderer, depthMode } = createWorldRenderer(THREE, { reversed: true }));
			scratch = new THREE.Vector3();
			renderer.domElement.dataset.testid = `${testid}-canvas`;
			host.prepend(renderer.domElement);
			scene = new THREE.Scene();
			scene.background = new THREE.Color(0x9ec3e6);
			camera = new THREE.PerspectiveCamera(fovY, 1.6, 0.5, 100_000);
			observer = new ResizeObserver(resize);
			observer.observe(host);
			resize();
			ensureFrame();
			draw();
		} catch (e) {
			if (!destroyed) error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	});

	onDestroy(() => {
		destroyed = true;
		abort.abort();
		if (raf) cancelAnimationFrame(raf);
		if (retry) clearTimeout(retry);
		observer?.disconnect();
		terrain?.dispose();
		renderer?.dispose();
		renderer?.domElement.remove();
	});
</script>

<div
	class="world-scene"
	bind:this={host}
	data-testid={testid}
	data-ready={!loading && !error}
	data-depth={depthMode}
	{onpointerdown}
	{onpointermove}
	{onpointerup}
	onpointercancel={onpointerup}
	{onwheel}
	role="application"
	aria-label="3D world: drag to look around, scroll or pinch to rise"
>
	{#if error}
		<div class="message" data-testid="{testid}-error">{error}</div>
	{:else if loading}
		<div class="message" data-testid="{testid}-loading">Loading the 3D world…</div>
	{/if}
	{#if credits.length}
		<div class="credits" data-testid="{testid}-credits">
			{#each credits as c, i (c.text)}
				{#if i}<span> · </span>{/if}<a href={c.terms_url ?? c.url} target="_blank" rel="noopener">{c.text}</a>
			{/each}
		</div>
	{/if}
</div>

<style>
	.world-scene {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		touch-action: none;
		background: #9ec3e6;
	}
	.world-scene :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}
	.message {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #1d2b3a;
		font: 500 14px system-ui, sans-serif;
	}
	.credits {
		position: absolute;
		right: 0;
		bottom: 0;
		max-width: 100%;
		padding: 2px 6px;
		background: rgba(255, 255, 255, 0.7);
		color: #333;
		font: 10px system-ui, sans-serif;
		text-align: right;
	}
	.credits a {
		color: inherit;
	}
</style>
