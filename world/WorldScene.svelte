<script lang="ts">
	/**
	 * The 3D world as an observer standing at a point (ea05): earth's terrain round them, its
	 * orthophoto draped on it, looking along a bearing. The lean core both apps mount; each app's
	 * own panel round it decides where the observer stands and what a turn of the view writes back.
	 *
	 * Position and bearing are props (the app's one location state); a drag turns the view and says
	 * so through `onlook`; the height stick or a pinch raises the eye, the wheel sets the fly speed. Nothing is drawn but on a change: a
	 * moved view, a loaded tile, a resize.
	 *
	 * What is drawn is the viewer's choice (ea07, sceneLayers.ts): bare or surface ground, the orthophoto, IPR's
	 * buildings, an atlas version or none, place names, chosen in WorldSceneControls and kept per viewer under
	 * `layersKey`. Every layer asks through one WorldRequests, which the loading overlay (WorldRequestPanel) reads.
	 *
	 * NAMES are the workbench's (labelPool.ts round the camera, worldNames.ts to draw them), from the channel's names
	 * release. While they are shown the frame is drawn through a DepthTarget, so what the scene puts in front of a
	 * name hides it, as in the workbench; a verdict that comes back later repaints the names alone.
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
		savedFlyLayout, savedFlySpeed, zoomedFov, ZOOM_PLUS_MINUS, type FlyLayout } from './flight';
	import { credits as earthCredits, layerUrls, loadEarth, type Credit, type Earth } from './earth';
	import { SOURCE_NAMES, TerrainTiles, horizonM, zoomOf } from './terrainTiles';
	import { DepthTarget, createWorldRenderer, type DepthMode } from './renderer';
	import { LabelPool } from './labelPool';
	import { WorldNames } from './worldNames';
	import { ViewGate, cameraView } from './view';
	import { AtlasCloud, atlasCredits, loadAtlas, loadPointer, type AtlasVersion } from './atlasCloud';
	import type { CityModelTiles } from './cityModelTiles';
	import { WorldRequests } from './worldRequests';
	import { layerProgress, type LoadProgress } from './loadProgress';
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
		/** the atlas point budget a viewer starts with, MiB (one of WORLD_POINT_BUDGETS); the viewer's own choice in
		 * the controls is kept with the layers and wins from then on */
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
	let layers = $state<SceneLayers>(untrack(() => readLayers(saved(layersKey), atlasChannels, atlasBudgetMiB)));
	$effect(() => keep(layersKey, JSON.stringify(layers)));

	let host: HTMLDivElement;
	let error = $state<string | null>(null);
	let earth = $state.raw<Earth | null>(null);
	/** earth not answering: the scene runs without its layers (the operator, 11-02: earth down must not stop flight)
	 * and asks again every EARTH_RETRY_MS */
	let earthError = $state<string | null>(null);
	const EARTH_RETRY_MS = 30_000;
	let earthRetry: ReturnType<typeof setTimeout> | 0 = 0;
	const urls = $derived(earth ? layerUrls(earth.base, earth.releases, layers.terrain) : null);
	const orthoShown = $derived(layers.ortho && !!urls?.orthoUrl);
	const buildingsShown = $derived(layers.buildings && !!urls?.modelsUrl);
	const namesShown = $derived(layers.names && !!urls?.namesUrl);
	/** the atlas version drawn: its licence and credits join the line */
	let atlasVersion = $state.raw<AtlasVersion | null>(null);
	/** the credit line names exactly the sources of what is drawn */
	const credits = $derived.by((): Credit[] => {
		if (!earth) return [];
		const c = earthCredits(earth.sources, { orthoYear: orthoShown ? earth.orthoYear : null, models: buildingsShown,
			names: namesShown });
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
	let labelPool: LabelPool | null = null;
	let worldNames: WorldNames | null = null;
	let depthTarget: DepthTarget | null = null;
	let namesCanvas = $state<HTMLCanvasElement>();
	/** placed/seen/considered names, as the workbench's data-names says them */
	let namesAttr = $state('');
	let namesRepaint = 0;
	/** when the view or what it draws last changed, and the gate's last answer: what `settled` is judged on */
	let lastChange = 0;
	let lastAsk = '';
	/** the scene's frame: every earth layer is laid in it, and laid again when the observer outruns it */
	let frame = $state.raw<Frame | null>(null);
	/** the ground under the observer: the terrain's, else the last it gave; with neither (earth unreachable from the
	 * start) the atlas's points there (AtlasCloud.groundAt), so the observer stands among them, not under them */
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
	/** each layer's loaded of wanted, while anything is pending: the overlay's summary (loadProgress.layerProgress) */
	let progress = $state<LoadProgress | null>(null);
	const unprogress = requests.subscribe(() => { progress = layerProgress(requests.snapshot()); });
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
		if (!three || !scene) return;
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
		terrain?.setFrame(next);
		buildings?.setFrame(next);
	}

	/** what loaded says where the ground is, and so what is in view: choose again */
	function changed() {
		gate.reset();
		draw();
	}

	/** the ground, for this model and orthophoto: laid again whenever one of them changes; a re-layout of the frame
	 * only moves it (ensureFrame, setFrame) */
	$effect(() => {
		const up = sceneUp, tileUrl = urls?.tileUrl, orthoUrl = orthoShown ? urls?.orthoUrl : undefined;
		if (!up || !tileUrl) return;
		untrack(() => {
			terrain?.dispose();
			ground = null;
			terrain = new TerrainTiles(three!, { tileUrl, orthoUrl, orthoExtent: earth?.orthoExtent ?? undefined, frame: frame!, requests, onChange: changed });
			scene!.add(terrain.group);
			changed();
		});
	});

	/** IPR's buildings, while they are shown (their module only loads once they are); a re-layout only moves them */
	let buildingsGeneration = 0;
	$effect(() => {
		const up = sceneUp, manifestUrl = buildingsShown ? urls?.modelsUrl : undefined;
		const generation = ++buildingsGeneration;
		untrack(() => {
			buildings?.dispose();
			buildings = null;
			draw();
		});
		if (!up || !manifestUrl) return;
		import('./cityModelTiles').then(({ CityModelTiles }) => {
			if (destroyed || generation !== buildingsGeneration || !frame) return;
			buildings = new CityModelTiles({ manifestUrl, frame, requests, onChange: changed });
			scene!.add(buildings.group);
			changed();
		}).catch((e) => { error = `buildings: ${e instanceof Error ? e.message : String(e)}`; });
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
	/** every ground point flight wrote since take-off (the last MAX_SENT): the app's location coming back as one of them,
	 * within a map pixel, is its own echo -- a map writes its centre back after it moved there, rounded, and late. Late
	 * is any time: it was "the last 3 s" until 2026-11-02, and a map echo slower than that (a slow frame, Leaflet's pan)
	 * read as a move of the user's and landed the flight, the altitude snapping back to the eye height (the operator:
	 * "the viewer altitude resetting kinda randomly"). A move of the user's lands within a pixel of the path never. */
	let sent: { lat: number; lon: number }[] = [];
	let sentT = 0;
	const MAX_SENT = 10_000;
	/** the camera's height over the ground while it flies (the eye height's stand-in for the far plane) */
	let flownEyeM = 0;
	/** the zoom keys (ZOOM_PLUS_MINUS) narrowed or widened the view */
	let zoom = $state<number | null>(null);
	const fov = $derived(zoom ?? fovY);
	const REPORT_MS = 300, MOVED_M = 0.1;

	function takeOff() {
		if (!flight || !camera) return;
		// the path starts where the app stands: until the map echoes the first report, a bearing echo, a zoom or a pull
		// of the stick finds the app's location still here (RECON-UI)
		if (!flying) sent = [{ lat, lon }];
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
		const moving = flight.step(camera, dt, { thrust: [0, stick, 0] });
		keepAboveGround();
		report(!moving);
		render();
		if (moving) flyFrame = requestAnimationFrame(fly);
		else flyT = 0;
	}
	/** the flown camera stays MIN_EYE_M over the loaded ground: flying into a hill put it under the terrain, which read as
	 * the world jumping (the operator, 11-02). It slides along the ground instead; where no terrain is loaded it flies free */
	function keepAboveGround() {
		if (!frame || !camera || !terrain) return;
		const [la, lo, h] = frame.toGeodetic(...(camera.position.toArray() as Vec3));
		const g = terrain.heightAt(la, lo);
		if (g !== null && h < g + MIN_EYE_M) camera.position.set(...frame.fromGeodetic(la, lo, g + MIN_EYE_M));
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
		// a point only when it moved: a look alone (a drag, a roll) writes no location, which on a phone files a row
		const last = sent.at(-1);
		if (!last || Math.hypot(...pairDelta(frame.fromGeodetic(last.lat, last.lon, 0), frame.fromGeodetic(la, lo, 0))) >= MOVED_M) {
			sent.push({ lat: la, lon: lo });
			if (sent.length > MAX_SENT) sent.splice(0, sent.length - MAX_SENT);
			onmove?.({ lat: la, lon: lo });
		}
		onlook?.(look);
	}
	const pairDelta = (a: Vec3, b: Vec3): [number, number] => [a[0] - b[0], a[1] - b[1]];
	/** back to the observer: standing at the eye height over the app's location */
	/** the last landing and why (the readout says it: a reset of the altitude explains itself) */
	let landed = $state('');
	function land(why: string) {
		landed = `landed ${new Date().toLocaleTimeString()}: ${why}`;
		flying = false;
		flight?.stop();
		if (flyFrame) cancelAnimationFrame(flyFrame);
		flyFrame = flyT = 0;
		sent = [];
		// a pull still held: standing again, it raises the eye (the fly loop had it till now)
		if (stick && !stickFrame) { stickT = 0; stickFrame = requestAnimationFrame(rise); }
		draw();
	}
	/** how far the app's location is from flight's path (its reports since take-off), in metres by the local scale of
	 * a degree (the points are a flight's, metres apart: no need of the frame's exact geodesy); Infinity with none */
	function offPathM(la: number, lo: number): number {
		const mLat = 111_320, mLon = 111_320 * Math.cos((la * Math.PI) / 180);
		let best = Infinity;
		for (const r of sent) best = Math.min(best, Math.hypot((r.lat - la) * mLat, (r.lon - lo) * mLon));
		return best;
	}
	/** within a map pixel of the path: flight's own report coming back, rounded, not a move of the app's */
	const echoTolerance = () => Math.max(1, locationPrecisionM);

	/** the names round the camera, for this frame, while they are shown */
	$effect(() => {
		const f = frame, url = namesShown ? urls?.namesUrl : undefined;
		untrack(() => {
			labelPool?.dispose();
			labelPool = null;
			if (f && url) labelPool = new LabelPool({ url, frame: f, requests, onChange: changed });
			draw();
		});
	});

	/** project, probe (with the frame's depth), lay out and paint the names; `depth` null paints the last verdicts */
	function drawNames(depth: THREE_NS.Texture | null) {
		if (!namesCanvas || !camera || !renderer || !three) return;
		const W = host.clientWidth || 1, H = host.clientHeight || 1;
		worldNames ??= new WorldNames(three, {
			// a verdict comes back a frame or more later: the names alone are painted again, nothing else is asked
			onVerdict: () => {
				if (!namesRepaint && !destroyed) namesRepaint = requestAnimationFrame(() => {
					namesRepaint = 0;
					drawNames(null);
					settle();
					// judged on a frame from before the last change (its probe was busy then): one more frame asks again,
					// and the verdict after it is fresh, so this does not loop
					if (labelPool && worldNames && worldNames.judgedAt < lastChange) draw();
				});
			}
		});
		if (!labelPool || !depthTarget) {
			worldNames.clear(namesCanvas, W, H);
			namesAttr = '';
			return;
		}
		labelPool.update(camera.position.toArray() as Vec3);
		const t = terrain;
		const list = labelPool.named(t ? (la, lo) => t.heightAt(la, lo) : null, t?.version ?? -1, [0, 0, 0]);
		const r = worldNames.draw(namesCanvas, W, H, { renderer, camera, list, depth, depthHeight: depthTarget.target.height,
			reversed: depthMode === 'reversed', relief: null, zoom: zoomOf(cameraView(camera, scratch!, H)) });
		if (r) namesAttr = `${r.placed}/${r.seen}/${r.items}${labelPool.stats.loading ? ' loading' : ''}`;
	}

	/** what the observer stands on, and whence (the readout's) */
	let standOn = 0;
	let groundFrom = '';
	let readout = $state('');
	/** the city models' drawn, loading and capped counts (data-buildings, for checks) */
	let buildingsAttr = $state('');
	/** the height readout (layers.readout): the camera, the ground under it and where it came from; heights are
	 * ellipsoidal, as earth serves them (sea level here is ~44 m) */
	function readoutOf(cam: Vec3): string {
		const [la, lo, h] = frame!.toGeodetic(...cam);
		if (!flying) return `camera ${h.toFixed(1)} m = ground ${standOn.toFixed(1)} m (${groundFrom}) + eye ${eyeM.toFixed(1)} m`;
		const g = terrain?.groundAt(la, lo);
		return g ? `flying: camera ${h.toFixed(1)} m, ${(h - g.h).toFixed(1)} m over ground ${g.h.toFixed(1)} m (terrain z${g.z}, ${g.src === null ? 'source ?' : SOURCE_NAMES[g.src] ?? `source ${g.src}`})`
			: `flying: camera ${h.toFixed(1)} m, no ground under it loaded`;
	}

	function render() {
		raf = 0;
		if (!renderer || !scene || !camera || !frame) return;
		if (!flying) {
			const g = terrain?.groundAt(lat, lon);
			if (g) { ground = g.h; groundFrom = `terrain z${g.z}, ${g.src === null ? 'source ?' : SOURCE_NAMES[g.src] ?? `source ${g.src}`}`; }
			else if (ground !== null && !groundFrom.startsWith('last')) groundFrom = `last known (${groundFrom})`;
			const fromAtlas = ground === null ? atlas?.groundAt(lat, lon) ?? null : null;
			standOn = ground ?? fromAtlas ?? 0;
			if (ground === null) groundFrom = fromAtlas !== null ? 'the atlas points' : 'unknown: 0 m (no terrain, no atlas here)';
			const at = frame.fromGeodetic(lat, lon, standOn + eyeM);
			const d = direction(bearing, pitch);
			camera.position.set(...at);
			camera.up.set(0, 0, 1);
			camera.lookAt(at[0] + d[0], at[1] + d[1], at[2] + d[2]);
		}
		const cam = camera.position.toArray() as Vec3;
		if (layers.readout) readout = readoutOf(cam);
		camera.fov = fov;
		camera.near = depthMode === 'reversed' ? 0.05 : 0.5;
		camera.far = Math.max(5_000, horizonM(flying ? flownEyeM : eyeM) * 1.5 + 50_000);
		camera.updateProjectionMatrix();
		const v = cameraView(camera, scratch!, host.clientHeight || 800);
		const ask = gate.state(cam, v, performance.now());
		if (ask === 'due') {
			lastChange = performance.now();
			terrain?.update(cam, v);
			buildings?.update(cam, v);
			atlas?.update(camera, renderer.getDrawingBufferSize(new three!.Vector2()).y, depthMode === 'reversed');
		}
		// drawn only on change: a view the gate held back is asked for once its interval is up
		else if (ask === 'soon' && !retry) retry = setTimeout(() => { retry = 0; draw(); }, gate.interval);
		if (labelPool) {
			// drawn where its depth can be read, so the names can be judged against it
			const size = renderer.getDrawingBufferSize(new three!.Vector2());
			depthTarget ??= new DepthTarget(three!, size.x, size.y, depthMode ?? 'standard');
			depthTarget.setSize(size.x, size.y);
			depthTarget.render(renderer, scene, camera);
			drawNames(depthTarget.target.depthTexture);
		} else {
			renderer.render(scene, camera);
			// no names, no target: half-float with 4 samples is ~37 MB of a phone's GPU (RECON-UI)
			depthTarget?.dispose();
			depthTarget = null;
			if (namesAttr || worldNames) drawNames(null);
		}
		const st = terrain?.stats;
		tiles = st ? `${st.ready}/${st.wanted}${st.failed ? ` failed ${st.failed}` : ''}` : '';
		if (buildings) {
			const b = buildings.stats;
			buildingsAttr = `${b.drawn} drawn, ${b.loading} loading, ${b.capped} capped`;
		} else buildingsAttr = '';
		if (atlas) {
			const a = atlas.summary;
			atlasState = `${a.points} points${a.limited ? ' (budget full)' : ''}${atlas.idle ? '' : ', loading'}`;
			atlasError = atlas.error;
		}
		lastAsk = ask;
		settle();
	}

	/** every layer loaded and quiet, and the names judged on a frame drawn since the last change (a verdict from
	 * before the far terrain loaded took 1,600 of 1,650 names for seen: the workbench, 2026-10-02). Never without
	 * terrain (earth unreachable): a waiter on data-settled then times out, and data-error says why */
	function settle() {
		const st = terrain?.stats;
		if (!st) return;
		settled = st.wanted > 0 && st.loading === 0 && lastAsk !== 'soon' && atlasOpened !== 'opening' &&
			(!atlas || (atlas.idle && !atlas.error)) && (!buildings || buildings.settled) && !labelPool?.stats.loading &&
			(!labelPool || !worldNames?.judging || worldNames.judgedAt >= lastChange);
	}

	/** ask for one frame; many asks before it lands are one frame */
	function draw() {
		if (!raf && !destroyed) raf = requestAnimationFrame(render);
	}

	// a move of the observer (the app's location state) or of the view; one flight did not make lands it
	$effect(() => {
		void lat; void lon; void bearing; void pitch; void eyeM; void fov;
		untrack(() => {
			const off = flying ? offPathM(lat, lon) : 0;
			if (off > echoTolerance())
				land(`the map moved ${Number.isFinite(off) ? `${off.toFixed(1)} m off the flight path` : 'before flight reported'} (an echo is within ${echoTolerance().toFixed(1)} m)`);
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
	/** the height stick's pull, -1..1, squared with its sign (a small pull is fine control, a full one fast):
	 * standing, the eye rises or sinks by STICK_RISE e-folds a second at full pull (2 m to 900 m in about 4 s);
	 * flying, it is the thrust R/F give, along the camera's up */
	let stick = 0;
	let stickFrame = 0, stickT = 0;
	const STICK_RISE = 1.5;
	function onstick(d: number) {
		stick = d * Math.abs(d);
		if (!d) return;
		if (flying) { if (!flyFrame) flyFrame = requestAnimationFrame(fly); }
		else if (!stickFrame) { stickT = 0; stickFrame = requestAnimationFrame(rise); }
	}
	function rise(t: number) {
		stickFrame = 0;
		if (!stick || flying || destroyed) return;
		const dt = stickT ? Math.min(0.1, (t - stickT) / 1000) : 0;
		stickT = t;
		if (dt) raise(Math.exp(STICK_RISE * stick * dt));
		stickFrame = requestAnimationFrame(rise);
	}
	/** a turn of the wheel while standing says the speed it set for a moment (flying, the flight's line says it) */
	let speedShown = $state(false);
	let speedTimer: ReturnType<typeof setTimeout> | 0 = 0;

	function raise(factor: number) {
		const next = Math.max(MIN_EYE_M, Math.min(MAX_EYE_M, eyeM * factor));
		if (next !== eyeM) oneye?.(next);
	}
	function onwheel(e: WheelEvent) {
		e.preventDefault();
		// the wheel sets the fly speed, standing or flying, as in the workbench's; up and down are the stick's
		if (!e.deltaY) return;
		flySpeed = boundedFlySpeed(flySpeed * (e.deltaY < 0 ? 1.25 : 0.8));
		keep(FLY_SPEED_PREF, String(flySpeed));
		if (flying) return;
		speedShown = true;
		if (speedTimer) clearTimeout(speedTimer);
		speedTimer = setTimeout(() => { speedTimer = 0; speedShown = false; }, 1500);
	}
	function onkeydown(e: KeyboardEvent) {
		if (keyBelongsToControl(e, false) || e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.code === 'Escape' && flying) {
			land('Esc');
			e.preventDefault();
			return;
		}
		const z = zoomedFov(fov, e, ZOOM_PLUS_MINUS);
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
			const THREE = await import('three');
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
			foldTimer = setTimeout(() => (autoFolded = true), 5000);
			ensureFrame();
			draw();
		} catch (e) {
			if (!destroyed) error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
		void connectEarth();
	});

	/** earth's channel: its layers once it answers; until then the scene flies without them, and asks again */
	async function connectEarth() {
		earthRetry = 0;
		try {
			const e = await loadEarth(earthUrl, channel, { signal: abort.signal });
			if (destroyed) return;
			earthError = null;
			earth = e;
		} catch (e) {
			if (destroyed) return;
			earthError = `earth unreachable (${e instanceof Error ? e.message : String(e)}): no terrain, aerial photo or names; `
				+ `asking again every ${EARTH_RETRY_MS / 1000} s`;
			earthRetry = setTimeout(() => void connectEarth(), EARTH_RETRY_MS);
		}
	}

	async function labelAtlasVersions(url: string) {
		const found = await Promise.all(atlasChannels.map((ch) => loadPointer(url, ch, { signal: abort.signal }).then(
			(p) => ({ channel: ch, label: `${ch} · ${p.resolution === 'full' ? 'every point' : 'saved points'} · ${(p.points / 1e6).toFixed(0)} M` }),
			() => null)));
		if (!destroyed) atlasOptions = found.filter((o) => o !== null);
	}

	// the atlas opens once the scene is up (reading its hierarchy must not hold the terrain back), and again on every
	// switch of version; a re-layout of the frame only moves it (ensureFrame)
	const sceneUp = $derived(frame !== null);
	let atlasGeneration = 0;
	// a new budget opens the atlas again too: the residency's budget is fixed when it is made (WorldResidency)
	$effect(() => {
		const ch = layers.atlas;
		const mib = layers.atlasMiB;
		if (sceneUp && atlasUrl) untrack(() => void switchAtlas(atlasUrl, ch, mib));
	});

	async function switchAtlas(url: string, ch: string | null, mib: number) {
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
				budgetMiB: mib, onChange: () => draw() });
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
		if (namesRepaint) cancelAnimationFrame(namesRepaint);
		if (retry) clearTimeout(retry);
		if (earthRetry) clearTimeout(earthRetry);
		if (speedTimer) clearTimeout(speedTimer);
		if (stickFrame) cancelAnimationFrame(stickFrame);
		if (foldTimer) clearTimeout(foldTimer);
		atlas?.dispose();
		buildings?.dispose();
		labelPool?.dispose();
		worldNames?.dispose();
		depthTarget?.dispose();
		terrain?.dispose();
		unprogress();
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
	data-names={namesAttr}
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
	data-fov={fov.toFixed(2)}
	data-eye-m={eyeM.toFixed(1)}
	data-bearing={bearing.toFixed(2)}
	data-pitch={pitch.toFixed(2)}
	data-buildings={buildingsAttr}
	data-frame={frame ? `${frame.lat.toFixed(4)},${frame.lon.toFixed(4)}` : ''}
	data-fly-speed={flySpeed.toFixed(1)}
	role="application"
	aria-label="3D world: drag to look around, the stick or a pinch to rise, scroll for the fly speed; click it, then fly with the keys"
>
	<canvas class="names" bind:this={namesCanvas} data-testid="{testid}-names"></canvas>
	<!-- the loading overlay, as the workbench shows it; its own pointer and wheel, so its list scrolls and its controls
		 click under the scene's capture -->
	<div class="loading" role="region" aria-label="Loading" onpointerdown={(e) => e.stopPropagation()} onwheel={(e) => e.stopPropagation()}
		data-testid="{testid}-status" data-error={error ?? earthError ?? atlasError ?? ''}>
		<WorldRequestPanel {requests} {progress} floating={false}
			system={error ?? (loading ? 'Loading the 3D world…' : earthError ?? atlasError ?? '')}
			systemError={!!(error ?? earthError ?? atlasError)} />
	</div>
	{#if !loading && !error}
		<WorldSceneControls bind:layers bind:flyLayout {onstick} zoomKeys={ZOOM_PLUS_MINUS.label} ground={!!urls} ortho={!!urls?.orthoUrl} buildings={!!urls?.modelsUrl} names={!!urls?.namesUrl}
			atlas={atlasOptions} {testid} />
	{/if}
	{#if layers.readout && readout}
		<div class="readout" role="status" data-testid="{testid}-readout" title="Heights over the ellipsoid, as earth serves them (sea level here is about 44 m)"
			onpointerdown={(e) => e.stopPropagation()}>{readout}{#if landed}<br />{landed}{/if}</div>
	{/if}
	{#if flying}
		<div class="flight" role="status" data-testid="{testid}-flight" onpointerdown={(e) => e.stopPropagation()}>
			<span>flying · {Number(flySpeed.toPrecision(3))} m/s · scroll for speed</span>
			<button type="button" onclick={() => land('the Land button')} data-testid="{testid}-land" title="Back to the map's point (Esc)">Land</button>
		</div>
	{:else if speedShown}
		<div class="flight" role="status" data-testid="{testid}-fly-speed">fly speed {Number(flySpeed.toPrecision(3))} m/s</div>
	{/if}
	{#if credits.length}
		<!-- its own pointer events: the scene captures a pointer that goes down on it, and a link or button
			 under that capture never gets its click -->
		<div class="credits" role="note" data-testid="{testid}-credits" data-open={creditsOpen} onpointerdown={(e) => e.stopPropagation()}>
			<button type="button" class="credits-toggle" aria-expanded={creditsOpen} title={creditsOpen ? 'Hide credits' : 'Credits'}
				data-testid="{testid}-credits-toggle" onclick={() => (creditsToggled = !creditsOpen)}>ⓘ</button>
			{#if creditsOpen}
				{#each credits as c, i (i)}
					{#if i}<span>{' · '}</span>{/if}<a href={c.terms_url ?? c.url} target="_blank" rel="noopener">{c.text}</a
					>{#if c.changes}<span class="changes">{` (${c.changes})`}</span>{/if}
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
	/* a pointer's focus draws no ring; the keyboard's does */
	.world-scene:focus:not(:focus-visible) {
		outline: none;
	}
	.world-scene :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}
	/* over the WebGL canvas, under every control; the pointer goes through to the scene */
	.names {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	/* a host whose own UI overlaps the scene's top edge moves the overlay and the controls clear with
	   --world-scene-inset-top; the overlay stops short of the controls' button */
	.loading {
		position: absolute;
		top: var(--world-scene-inset-top, 8px);
		left: 8px;
		right: 52px;
	}
	.readout {
		position: absolute;
		left: 8px;
		right: 56px;
		bottom: calc(var(--world-scene-credits-bottom, 0px) + 60px);
		padding: 4px 8px;
		border-radius: 6px;
		background: rgba(19, 25, 35, 0.8);
		color: #eee;
		font: 11px ui-monospace, monospace;
		overflow-wrap: anywhere;
		pointer-events: auto;
		width: fit-content;
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
