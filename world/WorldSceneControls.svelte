<script lang="ts">
	/**
	 * The scene's layer controls (ea07): one small button in a corner, opening a panel of what the scene draws. A
	 * layer the channel does not have is not offered. Its own pointer events, as the credit line's: the scene captures
	 * a pointer that goes down on it, and a control under that capture never gets its click.
	 */
	import type { SceneLayers } from './sceneLayers';
	import { FLY_LAYOUTS, type FlyLayout } from './flight';
	import { WORLD_POINT_BUDGETS } from './worldPointBudget';
	import HeightStick from './HeightStick.svelte';

	let { layers = $bindable(), flyLayout = $bindable(), onstick, zoomKeys, ground, ortho, buildings, names, atlas, testid }: {
		layers: SceneLayers;
		/** which labels the flight keys go by (the keys themselves are physical) */
		flyLayout: FlyLayout;
		/** the height stick's deflection, -1..1, 0 when let go (HeightStick) */
		onstick: (d: number) => void;
		/** how the scene zooms, said after the flight keys (flight.ts ZoomKeys.label) */
		zoomKeys: string;
		/** earth answers: its ground can be chosen (without it the scene still flies, over the atlas) */
		ground: boolean;
		/** the channel has an orthophoto */
		ortho: boolean;
		/** the channel has city models */
		buildings: boolean;
		/** the channel has place names */
		names: boolean;
		/** the atlas versions offered, each with what its pointer says; empty without an atlas */
		atlas: { channel: string; label: string }[];
		testid: string;
	} = $props();

	let open = $state(false);
	let root = $state<HTMLDivElement>();

	function onwindowpointerdown(e: PointerEvent) {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}
	function onkeydown(e: KeyboardEvent) {
		if (open && e.key === 'Escape') open = false;
	}
</script>

<svelte:window {onkeydown} onpointerdown={onwindowpointerdown} />

<div class="controls" role="group" aria-label="Scene" bind:this={root} onpointerdown={(e) => e.stopPropagation()} onwheel={(e) => e.stopPropagation()}
	data-testid="{testid}-controls">
	<button type="button" class="toggle" aria-expanded={open} aria-label="Layers" title="Layers"
		onclick={() => (open = !open)} data-testid="{testid}-layers-toggle">
		<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
			<path d="M12 3 2 8l10 5 10-5-10-5Zm-7.6 9L2 13.2l10 5 10-5-2.4-1.2L12 15.8 4.4 12Zm0 4L2 17.2l10 5 10-5-2.4-1.2L12 19.8 4.4 16Z" />
		</svg>
	</button>
	{#if !open}
		<!-- under the layers button; the open panel takes its place -->
		<HeightStick {onstick} {testid} />
	{/if}
	{#if open}
		<div class="panel" role="group" aria-label="Layers" data-testid="{testid}-layers">
			{#if ground}
				<fieldset>
					<legend>Ground</legend>
					<label><input type="radio" bind:group={layers.terrain} value="bare" data-testid="{testid}-terrain-bare" /> bare terrain</label>
					<label><input type="radio" bind:group={layers.terrain} value="surface" data-testid="{testid}-terrain-surface" /> surface (roofs, trees)</label>
					{#if ortho}
						<label><input type="checkbox" bind:checked={layers.ortho} data-testid="{testid}-ortho" /> aerial photo</label>
					{/if}
				</fieldset>
			{/if}
			{#if buildings || names}
				<fieldset>
					<legend>On the ground</legend>
					{#if names}
						<label><input type="checkbox" bind:checked={layers.names} data-testid="{testid}-names-toggle" /> place names</label>
					{/if}
					{#if buildings}
						<label><input type="checkbox" bind:checked={layers.buildings} data-testid="{testid}-buildings" /> Prague 3D buildings</label>
					{/if}
				</fieldset>
			{/if}
			<fieldset class="fly">
				<legend>Fly</legend>
				<p data-testid="{testid}-fly-keys">click the view, then {FLY_LAYOUTS[flyLayout].label} · {zoomKeys}</p>
				<div class="layouts">
					{#each Object.keys(FLY_LAYOUTS) as l (l)}
						<label><input type="radio" bind:group={flyLayout} value={l} data-testid="{testid}-fly-{l}" /> {l}</label>
					{/each}
				</div>
			</fieldset>
			<fieldset>
				<legend>Readout</legend>
				<label><input type="checkbox" bind:checked={layers.readout} data-testid="{testid}-readout-toggle" /> heights (camera, ground, landings)</label>
			</fieldset>
			{#if atlas.length}
				<fieldset>
					<legend>Point cloud</legend>
					<label><input type="radio" bind:group={layers.atlas} value={null} data-testid="{testid}-atlas-off" /> off</label>
					{#each atlas as a (a.channel)}
						<label><input type="radio" bind:group={layers.atlas} value={a.channel} data-testid="{testid}-atlas-{a.channel}" /> {a.label}</label>
					{/each}
					{#if layers.atlas !== null}
						<!-- the points held at once; a change opens the atlas again (WorldScene) -->
						<label title="memory for points (geometry only; the browser and GPU take more)">
							budget
							<select bind:value={layers.atlasMiB} data-testid="{testid}-atlas-budget">
								{#each WORLD_POINT_BUDGETS as mib (mib)}
									<option value={mib}>{mib} MiB</option>
								{/each}
							</select>
						</label>
					{/if}
				</fieldset>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* a host whose own UI overlaps the scene's top edge moves the controls clear with --world-scene-inset-top */
	.controls {
		position: absolute;
		top: var(--world-scene-inset-top, 8px);
		right: 8px;
		/* the panel scrolls within the scene, however short a phone's split leaves it */
		max-height: calc(100% - var(--world-scene-inset-top, 8px) - 8px);
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
		font: 13px system-ui, sans-serif;
		color: #1d2b3a;
	}
	.toggle {
		flex: none;
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.85);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
		cursor: pointer;
	}
	.toggle[aria-expanded='true'] {
		background: white;
	}
	.toggle path {
		fill: #1d2b3a;
	}
	.panel {
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		padding: 6px 10px;
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.95);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
	}
	fieldset {
		margin: 0;
		padding: 4px 0;
		border: 0;
	}
	fieldset + fieldset {
		border-top: 1px solid #dde3ea;
	}
	legend {
		padding: 0;
		font-weight: 600;
		font-size: 12px;
		color: #4a5a6c;
	}
	/* no keys to fly with on a touch-only device */
	@media (hover: none) and (pointer: coarse) {
		.fly {
			display: none;
		}
	}
	.fly p {
		max-width: 16em;
		margin: 2px 0;
		color: #4a5a6c;
		font-size: 12px;
	}
	.layouts {
		display: flex;
		gap: 12px;
	}
	label {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0;
		white-space: nowrap;
		cursor: pointer;
	}
</style>
