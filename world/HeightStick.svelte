<script lang="ts">
	/**
	 * Up and down as a spring-back stick (the operator, 2026-11-02: the wheel sets the fly speed, as in the workbench;
	 * up/down moves to "a drag/pull stickshift control"). Pull the knob up to rise, down to sink: `onstick` gets the
	 * deflection in -1..1 as it moves, and 0 when let go, the knob springing back. What the deflection does (the eye's
	 * height, a flight's vertical thrust) is the scene's.
	 */
	let { onstick, testid }: { onstick: (d: number) => void; testid: string } = $props();

	const TRAVEL_PX = 34;
	let d = $state(0);
	let start: { id: number; y: number } | null = null;
	let held = $state(false);

	function set(next: number) {
		if (next === d) return;
		d = next;
		onstick(d);
	}
	function onpointerdown(e: PointerEvent) {
		e.stopPropagation();
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		start = { id: e.pointerId, y: e.clientY };
		held = true;
	}
	function onpointermove(e: PointerEvent) {
		if (start?.id !== e.pointerId) return;
		set(Math.max(-1, Math.min(1, (start.y - e.clientY) / TRAVEL_PX)));
	}
	function onpointerup(e: PointerEvent) {
		if (start?.id !== e.pointerId) return;
		start = null;
		held = false;
		set(0);
	}
</script>

<div class="stick" role="slider" aria-label="Rise or sink: pull up or down" aria-orientation="vertical"
	aria-valuemin={-1} aria-valuemax={1} aria-valuenow={Number(d.toFixed(2))} tabindex="-1"
	{onpointerdown} {onpointermove} {onpointerup} onpointercancel={onpointerup} onwheel={(e) => e.stopPropagation()}
	title="Rise or sink: pull up or down" data-testid="{testid}-stick" data-value={d.toFixed(2)}>
	<span class="arrow up" aria-hidden="true">▲</span>
	<span class="knob" class:held style:transform="translateY({-d * TRAVEL_PX}px)"></span>
	<span class="arrow down" aria-hidden="true">▼</span>
</div>

<style>
	.stick {
		position: relative;
		flex: none;
		width: 36px;
		height: 108px;
		border-radius: 18px;
		background: rgba(255, 255, 255, 0.85);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
		touch-action: none;
		cursor: ns-resize;
		user-select: none;
	}
	.knob {
		position: absolute;
		left: 6px;
		top: 42px;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: #1d2b3a;
		/* springs back when let go; follows the pointer exactly while held */
		transition: transform 0.15s ease-out;
	}
	.knob.held {
		transition: none;
	}
	.arrow {
		position: absolute;
		left: 0;
		width: 100%;
		text-align: center;
		font: 9px system-ui, sans-serif;
		color: #6b7a8c;
	}
	.up {
		top: 4px;
	}
	.down {
		bottom: 4px;
	}
</style>
