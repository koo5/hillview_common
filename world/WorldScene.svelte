<script lang="ts">
	/**
	 * The 3D world as an observer standing at a point (ea05): earth's terrain round them, its
	 * orthophoto draped on it, looking along a bearing. The lean core both apps mount; each app's
	 * own panel round it decides where the observer stands and what a turn of the view writes back.
	 *
	 * Position and bearing are props (the app's one location state); a drag turns the view and says
	 * so through `onlook`, the wheel or a pinch raises the eye. Nothing is drawn but on a change: a
	 * moved view, a loaded tile, a resize.
	 *
	 * What is drawn is the viewer's choice (ea07, sceneLayers.ts): bare or surface ground, the orthophoto, IPR's
	 * buildings, an atlas version or none, chosen in WorldSceneControls and kept per viewer under `layersKey`. Every
	 * layer asks through one WorldRequests, which the loading overlay (WorldRequestPanel) reads.
	 *
	 * FLIGHT (ea07, flight.ts): with the scene focused, a fly key frees the camera from the app's location and flies it
	 * as the workbench's viewer does. While it flies, its ground point and heading are written back (`onmove`,
	 * `onlook`), so the app's map follows; the app's location coming back as that same point is flight's own echo. A
	 * move the scene did not make -- the map dragged, a photo chosen -- lands it: the observer stands at the eye height
	 * over the new point, as before flight. Esc or the Land button lands it where it is.
	 */
	import { onDestroy, onMount, untrack } from 'svelte';
	import type * as THREE_NS from 'three';
	import { Frame, rigid, type Vec3 } from './geodesy';
	import { headingOf, localAxes } from './compass';
	import { FLY_LAYOUT_PREF, FLY_SPEED_PREF, Flight, FlyKeys, LOOK_RAD_PER_PX, boundedFlySpeed, keyBelongsToControl, lookScale,
		savedFlyLayout, savedFlySpeed, zoomedFov, type FlyLayout } from './flight';
	import { credits as earthCredits, layerUrls, loadEarth, type Credit, type Earth } from './earth';
	import { TerrainTiles, horizonM } from './terrainTiles';
	import { createWorldRenderer, type DepthMode } from './renderer';
	import { ViewGate, cameraView } from './view';
	import { AtlasCloud, atlasCredits, loadAtlas, loadPointer, type AtlasVersion } from './atlasCloud';
	import type { CityModelTiles } from './cityModelTiles';
	import { WorldRequests } from './worldRequests';
	import { readLayers, type SceneLayers } from './sceneLayers';
	import WorldRequestPanel from './WorldRequestPanel.svelte';
	import WorldSceneControls from './WorldSceneControls.svelte';

	type Props = {
		/** the earth service's base URL */
		earthUrl: string;
		channel?: string;
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
		/** flight moved the observer: the ground point under it now (the app's location follows) */
		onmove?: (at: { lat: number; lon: number }) => void;
		/** how coarsely the app's location comes back after an `onmove` (a map rounds its centre to its pixels), metres:
		 * a location that close to one of flight's own reports is its echo, not a move */
		locationPrecisionM?: number;
		/** a published atlas (atlas.hillview.cz): a channel's world snapshot is drawn as points */
		atlasUrl?: string;
		/** the atlas channels a viewer may choose between, the default first */
		atlasChannels?: string[];
		atlasBudgetMiB?: number;
		/** where this viewer's layer choices are kept */
		layersKey?: string;
		testid?: string;
	};
	let {
		earthUrl, channel = 'prod', lat, lon, bearing, pitch = -5, eyeM = 2, fovY = 55,
		onlook, oneye, onmove, locationPrecisionM = 1, atlasUrl, atlasChannels = ['prod'], atlasBudgetMiB = 64, layersKey = 'world.scene.layers',
		testid = 'world-scene'
	}: Props = $props();

	/** a frame is good for this far from its origin; past it the scene is laid out again */
	const REFRAME_M = 20_000;
	const MIN_EYE_M = 1.5, MAX_EYE_M = 20_000;

	function saved(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	function keep(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			/* preferences unavailable: the choice lasts this visit */
		}
	}
	let layers = $state<SceneLayers>(untrack(() => readLayers(saved(layersKey), atlasChannels)));
	$effect(() => keep(layersKey, JSON.stringify(layers)));

	let host: HTMLDivElement;
	let error = $state<string | null>(null);
	let earth = $state.raw<Earth | null>(null);
	const urls = $derived(earth ? layerUrls(earth.base, earth.releases, layers.terrain) : null);
	const orthoShown = $derived(layers.ortho && !!urls?.orthoUrl);
	const buildingsShown = $derived(layers.buildings && !!urls?.modelsUrl);
	/** the atlas version drawn: its licence and credits join the line */
	let atlasVersion = $state.raw<AtlasVersion | null>(null);
	/** the credit line names exactly the sources of what is drawn */
	const credits = $derived.by((): Credit[] => {
		if (!earth) return [];
		const c = earthCredits(earth.sources, orthoShown ? earth.orthoYear : null, buildingsShown);
		return atlasVersion ? atlasCredits(c, atlasVersion) : c;
	});
	/** the atlas versions offered, labelled by their pointers; a channel whose pointer cannot be read is not offered */
	let atlasOptions = $state<{ channel: string; label: string }[]>([]);
	/** the credit line: shown first on every scene (it carries ODbL attribution, which OSM's guidelines let fold only
	 * once it was shown). A narrow scene folds it behind its button on the first touch of the scene or after 5 s;
	 * the viewer's own toggle wins from then on. */
	let width = $state(0);
	let creditsToggled = $state<boolean | null>(null);
	let autoFolded = $state(false);
	let foldTimer: ReturnType<typeof setTimeout> | 0 = 0;
	const creditsOpen = $derived(creditsToggled ?? (width > 640 || !autoFolded));
	let loading = $state(true);

	let three: typeof THREE_NS | null = null;
	let renderer: THREE_NS.WebGLRenderer | null = null;
	let scene: THREE_NS.Scene | null = null;
	let camera: THREE_NS.PerspectiveCamera | null = null;
	let terrain: TerrainTiles | null = null;
	let buildings: CityModelTiles | null = null;
	/** the scene's frame: every earth layer is laid in it, and laid again when the observer outruns it */
	let frame = $state.raw<Frame | null>(null);
	let ground: number | null = null;
	let depthMode = $state<DepthMode | null>(null);
	/** the terrain's tiles: ready/wanted, and whether none is still loading (what a test waits for) */
	let tiles = $state('');
	let settled = $state(false);
	let atlas: AtlasCloud | null = null;
	/** the atlas's resident points and pending blocks; its failure, said on the page */
	let atlasState = $state('');
	let atlasError = $state<string | null>(null);
	/** the atlas's own start, after the scene is up: 'opening' while its hierarchy is read */
	let atlasOpened: 'none' | 'opening' | 'open' = 'none';
	const requests = new WorldRequests();
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
		if (!three || !scene || !earth) return;
		if (frame) {
			const [e, n] = frame.fromGeodetic(lat, lon, 0);
			if (Math.hypot(e, n) < REFRAME_M) return;
		}
		const next = new Frame(lat, lon, 0);
		if (flying && frame && camera) {
			// the flown camera, carried into the new frame (the frames' axes differ by the earth's curve between them)
			camera.updateMatrix();
			new three.Matrix4().set(...(rigid(frame, next) as Parameters<THREE_NS.Matrix4['set']>)).multiply(camera.matrix)
				.decompose(camera.position, camera.quaternion, camera.scale);
		}
		frame = next;
		atlas?.setScene(frame);
	}

	/** what loaded says where the ground is, and so what is in view: choose again */
	function changed() {
		gate.reset();
		draw();
	}

	/** the ground, for this frame, model and orthophoto: laid again whenever one of them changes */
	$effect(() => {
		const f = frame, tileUrl = urls?.tileUrl, orthoUrl = orthoShown ? urls?.orthoUrl : undefined;
		if (!f || !tileUrl) return;
		untrack(() => {
			terrain?.dispose();
			ground = null;
			terrain = new TerrainTiles(three!, { tileUrl, orthoUrl, frame: f, requests, onChange: changed });
			scene!.add(terrain.group);
			changed();
		});
	});

	/** IPR's buildings, for this frame, while they are shown (their module only loads once they are) */
	let buildingsGeneration = 0;
	$effect(() => {
		const f = frame, manifestUrl = buildingsShown ? urls?.modelsUrl : undefined;
		const generation = ++buildingsGeneration;
		untrack(() => {
			buildings?.dispose();
			buildings = null;
			draw();
		});
		if (!f || !manifestUrl) return;
		import('./cityModelTiles').then(({ CityModelTiles }) => {
			if (destroyed || generation !== buildingsGeneration) return;
			buildings = new CityModelTiles({ manifestUrl, frame: f, requests, onChange: changed });
			scene!.add(buildings.group);
			changed();
		}, (e) => { error = `buildings: ${e instanceof Error ? e.message : String(e)}`; });
	});

	// ---- flight ----
	const flyKeys = new FlyKeys(savedFlyLayout(saved(FLY_LAYOUT_PREF)));
	let flyLayout = $state<FlyLayout>(flyKeys.layout);
	$effect(() => {
		flyKeys.layout = flyLayout;
		keep(FLY_LAYOUT_PREF, flyLayout);
	});
	let flySpeed = $state(savedFlySpeed(saved(FLY_SPEED_PREF)));
	let flight: Flight | null = null;
	let flying = $state(false);
	let flyFrame = 0, flyT = 0;
	/** the ground points flight wrote in the last ECHO_MS, and when: the app's location coming back as one of them is
	 * its own echo (a map writes its centre back after it moved there, rounded, and a report or two late) */
	let sent: { lat: number; lon: number; t: number }[] = [];
	let sentT = 0;
	/** the camera's height over the ground while it flies (the eye height's stand-in for the far plane) */
	let flownEyeM = 0;
	/** Z/X narrowed or widened the view */
	let zoom = $state<number | null>(null);
	const fov = $derived(zoom ?? fovY);
	const REPORT_MS = 300, ECHO_MS = 3000;

	function takeOff() {
		if (!flight || !camera) return;
		flying = true;
		if (!flyFrame) flyFrame = requestAnimationFrame(fly);
	}
	function fly(t: number) {
		flyFrame = 0;
		if (!flying || !flight || !camera || destroyed) return;
		// real elapsed time, so a slow device flies as far as a fast one; at most a second, so a tab that was away
		// does not jump the camera on its return
		const dt = flyT ? Math.min(1, (t - flyT) / 1000) : 0;
		flyT = t;
		flight.speed = flySpeed;
		const moving = flight.step(camera, dt);
		report(!moving);
		render();
		if (moving) flyFrame = requestAnimationFrame(fly);
		else flyT = 0;
	}
	/** where flight has the observer, written back (at most every REPORT_MS, and once it comes to rest) */
	function report(now: boolean) {
		if (!frame || !camera || (!now && performance.now() - sentT < REPORT_MS)) return;
		const p = camera.position.toArray() as Vec3;
		const [la, lo, h] = frame.toGeodetic(...p);
		const g = terrain?.heightAt(la, lo);
		if (g != null) flownEyeM = Math.max(0, h - g);
		const look = headingOf(camera.getWorldDirection(new three!.Vector3()).toArray() as Vec3, localAxes(frame, p));
		sentT = performance.now();
		sent = [...sent.filter((r) => sentT - r.t < ECHO_MS), { lat: la, lon: lo, t: sentT }];
		onmove?.({ lat: la, lon: lo });
		onlook?.(look);
	}
	/** back to the observer: standing at the eye height over the app's location */
	function land() {
		flying = false;
		flight?.stop();
		if (flyFrame) cancelAnimationFrame(flyFrame);
		flyFrame = flyT = 0;
		sent = [];
		draw();
	}
	/** the app's location is one of flight's own recent reports, as the app rounds it: not a move of the app's */
	function isEcho(la: number, lo: number): boolean {
		if (!frame) return false;
		const a = frame.fromGeodetic(la, lo, 0), tolerance = Math.max(1, locationPrecisionM);
		return sent.some((r) => {
			const b = frame!.fromGeodetic(r.lat, r.lon, 0);
			return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
		});
	}

	function render() {
		raf = 0;
		if (!renderer || !scene || !camera || !frame || !terrain) return;
		if (!flying) {
			ground = terrain.heightAt(lat, lon) ?? ground;
			const at = frame.fromGeodetic(lat, lon, (ground ?? 0) + eyeM);
			const d = direction(bearing, pitch);
			camera.position.set(...at);
			camera.up.set(0, 0, 1);
			camera.lookAt(at[0] + d[0], at[1] + d[1], at[2] + d[2]);
		}
		const cam = camera.position.toArray() as Vec3;
		camera.fov = fov;
		camera.near = depthMode === 'reversed' ? 0.05 : 0.5;
		camera.far = Math.max(5_000, horizonM(flying ? flownEyeM : eyeM) * 1.5 + 50_000);
		camera.updateProjectionMatrix();
		const v = cameraView(camera, scratch!, host.clientHeight || 800);
		const ask = gate.state(cam, v, performance.now());
		if (ask === 'due') {
			terrain.update(cam, v);
			buildings?.update(cam, v);
			atlas?.update(camera, renderer.getDrawingBufferSize(new three!.Vector2()).y, depthMode === 'reversed');
		}
		// drawn only on change: a view the gate held back is asked for once its interval is up
		else if (ask === 'soon' && !retry) retry = setTimeout(() => { retry = 0; draw(); }, gate.interval);
		renderer.render(scene, camera);
		const st = terrain.stats;
		tiles = `${st.ready}/${st.wanted}${st.failed ? ` failed ${st.failed}` : ''}`;
		if (atlas) {
			const a = atlas.summary;
			atlasState = `${a.points} points${a.limited ? ' (budget full)' : ''}${atlas.idle ? '' : ', loading'}`;
			atlasError = atlas.error;
		}
		settled = st.wanted > 0 && st.loading === 0 && ask !== 'soon' && atlasOpened !== 'opening' &&
			(!atlas || (atlas.idle && !atlas.error)) && (!buildings || buildings.settled);
	}

	/** ask for one frame; many asks before it lands are one frame */
	function draw() {
		if (!raf && !destroyed) raf = requestAnimationFrame(render);
	}

	// a move of the observer (the app's location state) or of the view; one flight did not make lands it
	$effect(() => {
		void lat; void lon; void bearing; void pitch; void eyeM; void fov;
		untrack(() => {
			if (flying && !isEcho(lat, lon)) land();
			ensureFrame();
		});
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
		return fov / Math.max(1, host.clientHeight);
	}
	function onpointerdown(e: PointerEvent) {
		autoFolded = true;
		// the keys fly only while the scene has focus, so the app's own shortcuts keep theirs
		host.focus({ preventScroll: true });
		host.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		pinch = null;
	}
	function onpointermove(e: PointerEvent) {
		const last = pointers.get(e.pointerId);
		if (!last) return;
		if (pointers.size === 2) {
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (flying) return;
			const [a, b] = [...pointers.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (pinch !== null && d > 0) raise(pinch / d);
			pinch = d;
			return;
		}
		const k = degPerPx();
		const dx = e.clientX - last.x, dy = e.clientY - last.y;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (flying && flight && camera) {
			// the drag grabs the view as on the ground: the same angle per pixel, turned the way the hand moves
			const px = (k * Math.PI) / 180 / (LOOK_RAD_PER_PX * lookScale(camera));
			flight.look(-dx * px, -dy * px);
			takeOff();
			return;
		}
		const nb = (((bearing - dx * k) % 360) + 360) % 360;
		const np = Math.max(-89, Math.min(89, pitch + dy * k));
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
		if (!flying) return raise(Math.exp(e.deltaY * 0.002));
		// in flight the wheel sets the speed, as in the workbench's
		if (e.deltaY) {
			flySpeed = boundedFlySpeed(flySpeed * (e.deltaY < 0 ? 1.25 : 0.8));
			keep(FLY_SPEED_PREF, String(flySpeed));
		}
	}
	function onkeydown(e: KeyboardEvent) {
		if (keyBelongsToControl(e, false) || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.code === 'Escape' && flying) {
			land();
			e.preventDefault();
			return;
		}
		const z = zoomedFov(fov, e.code);
		if (z !== null) {
			zoom = z;
			e.preventDefault();
			return;
		}
		if (flyKeys.press(e.code)) {
			e.preventDefault();
			takeOff();
		}
	}
	function onkeyup(e: KeyboardEvent) {
		flyKeys.release(e.code);
	}
	function onfocusout(e: FocusEvent) {
		if (!host.contains(e.relatedTarget as Node | null)) flyKeys.clear();
	}

	let observer: ResizeObserver | null = null;
	onMount(async () => {
		if (atlasUrl) void labelAtlasVersions(atlasUrl);
		try {
			const [THREE, e] = await Promise.all([import('three'), loadEarth(earthUrl, channel, { signal: abort.signal })]);
			if (destroyed) return;
			three = THREE;
			({ renderer, depthMode } = createWorldRenderer(THREE, { reversed: true }));
			scratch = new THREE.Vector3();
			flight = new Flight(THREE, flyKeys, flySpeed);
			renderer.domElement.dataset.testid = `${testid}-canvas`;
			host.prepend(renderer.domElement);
			scene = new THREE.Scene();
			scene.background = new THREE.Color(0x9ec3e6);
			camera = new THREE.PerspectiveCamera(fovY, 1.6, 0.5, 100_000);
			observer = new ResizeObserver(resize);
			observer.observe(host);
			resize();
			earth = e;
			foldTimer = setTimeout(() => (autoFolded = true), 5000);
			ensureFrame();
			draw();
		} catch (e) {
			if (!destroyed) error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	});

	async function labelAtlasVersions(url: string) {
		const found = await Promise.all(atlasChannels.map((ch) => loadPointer(url, ch, { signal: abort.signal }).then(
			(p) => ({ channel: ch, label: `${p.resolution === 'full' ? 'every point' : 'saved points'} · ${(p.points / 1e6).toFixed(0)} M` }),
			() => null)));
		if (!destroyed) atlasOptions = found.filter((o) => o !== null);
	}

	// the atlas opens once the scene is up (reading its hierarchy must not hold the terrain back), and again on every
	// switch of version; a re-layout of the frame only moves it (ensureFrame)
	const sceneUp = $derived(frame !== null);
	let atlasGeneration = 0;
	$effect(() => {
		const ch = layers.atlas;
		if (sceneUp && atlasUrl) untrack(() => void switchAtlas(atlasUrl, ch));
	});

	async function switchAtlas(url: string, ch: string | null) {
		const generation = ++atlasGeneration;
		if (atlas) {
			scene?.remove(atlas.object);
			atlas.dispose();
		}
		atlas = null;
		atlasVersion = null;
		atlasState = '';
		atlasError = null;
		atlasOpened = 'none';
		draw();
		if (ch === null) return;
		atlasOpened = 'opening';
		atlasState = 'opening';
		try {
			const a = await loadAtlas(url, ch, { signal: abort.signal });
			if (destroyed || generation !== atlasGeneration || !frame || !three || !scene) return;
			const cloud = new AtlasCloud(three, { treeUrl: a.treeUrl, frame: new Frame(...a.version.origin), scene: frame, requests,
				budgetMiB: atlasBudgetMiB, onChange: () => draw() });
			await cloud.open();
			if (destroyed || generation !== atlasGeneration) { cloud.dispose(); return; }
			// a re-layout during the open went by while atlas was null: place the cloud in today's frame
			cloud.setScene(frame!);
			atlas = cloud;
			atlasVersion = a.version;
			scene.add(cloud.object);
			atlasOpened = 'open';
			changed();
		} catch (e) {
			if (destroyed || generation !== atlasGeneration) return;
			atlasOpened = 'none';
			atlasState = '';
			atlasError = `atlas: ${e instanceof Error ? e.message : String(e)}`;
			draw();
		}
	}

	onDestroy(() => {
		destroyed = true;
		abort.abort();
		if (raf) cancelAnimationFrame(raf);
		if (flyFrame) cancelAnimationFrame(flyFrame);
		if (retry) clearTimeout(retry);
		if (foldTimer) clearTimeout(foldTimer);
		atlas?.dispose();
		buildings?.dispose();
		terrain?.dispose();
		requests.dispose();
		observer?.disconnect();
		renderer?.dispose();
		renderer?.domElement.remove();
	});
</script>

<!-- role="application" is ARIA's role for a widget that takes its own pointer and keys (here: look, rise, fly);
	 svelte's list counts it non-interactive -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="world-scene"
	bind:this={host}
	bind:clientWidth={width}
	data-testid={testid}
	data-ready={!loading && !error}
	data-depth={depthMode}
	data-tiles={tiles}
	data-settled={settled}
	data-atlas={atlasState}
	data-layers={JSON.stringify(layers)}
	{onpointerdown}
	{onpointermove}
	{onpointerup}
	onpointercancel={onpointerup}
	{onwheel}
	{onkeydown}
	{onkeyup}
	{onfocusout}
	tabindex="0"
	data-flying={flying}
	role="application"
	aria-label="3D world: drag to look around, scroll or pinch to rise; click it, then fly with the keys"
>
	<!-- the loading overlay, as the workbench shows it; its own pointer and wheel, so its list scrolls and its controls
		 click under the scene's capture -->
	<div class="loading" role="region" aria-label="Loading" onpointerdown={(e) => e.stopPropagation()} onwheel={(e) => e.stopPropagation()}
		data-testid="{testid}-status" data-error={error ?? atlasError ?? ''}>
		<WorldRequestPanel {requests} floating={false} system={error ?? (loading ? 'Loading the 3D world…' : atlasError ?? '')}
			systemError={!!(error ?? atlasError)} />
	</div>
	{#if earth}
		<WorldSceneControls bind:layers bind:flyLayout ortho={!!urls?.orthoUrl} buildings={!!urls?.modelsUrl} atlas={atlasOptions} {testid} />
	{/if}
	{#if flying}
		<div class="flight" role="status" data-testid="{testid}-flight" onpointerdown={(e) => e.stopPropagation()}>
			<span>flying · {Number(flySpeed.toPrecision(3))} m/s · scroll for speed</span>
			<button type="button" onclick={land} data-testid="{testid}-land" title="Back to the map's point (Esc)">Land</button>
		</div>
	{/if}
	{#if credits.length}
		<!-- its own pointer events: the scene captures a pointer that goes down on it, and a link or button
			 under that capture never gets its click -->
		<div class="credits" role="note" data-testid="{testid}-credits" data-open={creditsOpen} onpointerdown={(e) => e.stopPropagation()}>
			<button type="button" class="credits-toggle" aria-expanded={creditsOpen} title={creditsOpen ? 'Hide credits' : 'Credits'}
				data-testid="{testid}-credits-toggle" onclick={() => (creditsToggled = !creditsOpen)}>ⓘ</button>
			{#if creditsOpen}
				{#each credits as c, i (i)}
					{#if i}<span>{' · '}</span>{/if}<a href={c.terms_url ?? c.url} target="_blank" rel="noopener">{c.text}</a>
				{/each}
			{/if}
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
	.world-scene:focus {
		outline: none;
	}
	.world-scene :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}
	/* a host whose own UI overlaps the scene's top edge moves the overlay and the controls clear with
	   --world-scene-inset-top; the overlay stops short of the controls' button */
	.loading {
		position: absolute;
		top: var(--world-scene-inset-top, 8px);
		left: 8px;
		right: 52px;
	}
	.flight {
		position: absolute;
		left: 8px;
		bottom: calc(var(--world-scene-credits-bottom, 0px) + 28px);
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 4px 4px 10px;
		border-radius: 16px;
		background: rgba(19, 25, 35, 0.85);
		color: #eee;
		font: 12px system-ui, sans-serif;
	}
	.flight button {
		padding: 3px 10px;
		border: 0;
		border-radius: 12px;
		background: #eee;
		color: #131923;
		font: inherit;
		cursor: pointer;
	}
	/* a host whose own UI overlaps the scene's corner moves the line clear with these two */
	.credits {
		position: absolute;
		right: var(--world-scene-credits-right, 0px);
		bottom: var(--world-scene-credits-bottom, 0px);
		max-width: calc(100% - var(--world-scene-credits-right, 0px));
		padding: 2px 6px;
		background: rgba(255, 255, 255, 0.7);
		color: #333;
		font: 10px system-ui, sans-serif;
		text-align: right;
	}
	.credits a {
		color: inherit;
	}
	.credits-toggle {
		margin-right: 4px;
		padding: 0 2px;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		font-size: 13px;
		line-height: 1;
		vertical-align: middle;
		cursor: pointer;
	}
	.credits[data-open='false'] {
		border-radius: 4px 0 0 0;
	}
</style>
