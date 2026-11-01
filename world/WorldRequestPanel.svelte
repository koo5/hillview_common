<script lang="ts" module>
	export type ServerActivity = { id: string; stage: string; detail?: string; url?: string; query?: string;
		bounds?: number[]; updated_at: number; finished_at?: number; attempts: number; children: ServerActivity[] };
	export type ServerReport = { instance: string; requests: ServerActivity[] };
</script>

<script lang="ts">
	/**
	 * The world's loading overlay (moved from the workbench, ea07): what the scene's requests are doing, one line or a
	 * summary or the full list, with an app's long-load progress and its system line. Where the app's server can say
	 * what a request is waiting on upstream (the workbench's /world/requests), it passes `serverActivity` and each row
	 * shows that stage; without it the rows say only what the browser knows.
	 */
	import { onMount } from 'svelte';
	import type { RequestInfo, WorldRequests } from './worldRequests';
	import type { LoadProgress } from './loadProgress';
	let { requests, system = '', systemError = false, floating = true, progress = null, topInset = 8, serverActivity,
		displayKey = 'world.loading.display' }: {
		requests: WorldRequests; system?: string; systemError?: boolean; floating?: boolean; progress?: LoadProgress | null;
		topInset?: number;
		/** what the app's server reports for these server ids (the workbench's /world/requests); polled while any loads */
		serverActivity?: (ids: string[], signal: AbortSignal) => Promise<ServerReport>;
		/** where this viewer's chosen size (one line, summary, details) is kept */
		displayKey?: string;
	} = $props();
	let rows = $state<RequestInfo[]>([]);
	let server = $state<Record<string, ServerActivity>>({});
	type Display='line'|'summary'|'details';
	let display=$state<Display>('summary');
	const expanded=$derived(display==='details');
	function setDisplay(value:string){
		if(!['line','summary','details'].includes(value))return;
		display=value as Display;
		try{localStorage.setItem(displayKey,display);}catch{/* preferences unavailable */}
	}
	let history = $state(false);
	let now = $state(Date.now());
	let monitorError = $state('');
	let instance = '';
	const busy = (r: RequestInfo) => r.wanted && ['queued', 'loading', 'retrying'].includes(r.state);
	const counts = $derived({
		loading: rows.filter(r => r.wanted && r.state === 'loading').length,
		queued: rows.filter(r => r.wanted && r.state === 'queued').length,
		retrying: rows.filter(r => r.wanted && r.state === 'retrying').length,
		missing: rows.filter(r => r.wanted && r.state === 'failed').length,
		loaded: rows.filter(r => r.wanted && r.state === 'loaded').length,
		received: rows.filter(r => !r.wanted && r.state === 'loaded').length
	});
	const assetsLoading = $derived(rows.some(r=>r.wanted&&r.state==='loading'&&r.kind!=='world'));
	const visible = $derived(expanded || !!system || !!progress || counts.loading + counts.queued + counts.retrying + counts.missing > 0);
	const pending = $derived(rows.filter(busy).sort((a, b) =>
		Number(b.state === 'loading') - Number(a.state === 'loading') || a.priority - b.priority));
	const front = $derived(pending[0]);
	const summary = $derived(system ? `system · ${system}` : counts.loading
		? `${counts.loading} loading · ${front?.label ?? 'world data'}${front?.serverId && server[front.serverId]?.detail ? ` · ${server[front.serverId].detail}` : ''}`
		: counts.retrying ? `${counts.retrying} retrying · ${pending.find(r => r.state === 'retrying')?.error ?? ''}`
		: counts.queued ? `${counts.queued} queued` : counts.missing ? `${counts.missing} operations failed` : 'Idle · nothing pending');
	const ordered = $derived(rows.filter(r => history || r.wanted).sort((a, b) => {
		const rank = (r: RequestInfo) => r.wanted && r.state === 'loading' ? 0 : r.wanted && r.state === 'retrying' ? 1 : r.wanted && r.state === 'queued' ? 2 : r.wanted && r.state === 'failed' ? 3 : r.state === 'loaded' ? 4 : 5;
		return rank(a) - rank(b) || a.priority - b.priority || b.createdAt - a.createdAt;
	}));
	const elapsed = (r: RequestInfo) => Math.max(0, Math.floor(((r.finishedAt ?? now) - (r.startedAt ?? r.createdAt)) / 1000));
	const retryIn = (r: RequestInfo) => Math.max(0, Math.ceil(((r.retryAt ?? now) - now) / 1000));

	onMount(() => {
		try{const saved=localStorage.getItem(displayKey);if(saved)setDisplay(saved);}catch{/* preferences unavailable */}
		let flush: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = requests.subscribe(() => {
			if (!flush) flush = setTimeout(() => { flush = undefined; rows = requests.snapshot(); }, 80);
		});
		rows = requests.snapshot();
		const ticker = setInterval(() => { now = Date.now(); }, 1000);
		const controller = new AbortController();
		let polling = false;
		async function poll() {
			if (polling || controller.signal.aborted) return;
			// This status read observes the data registry; it never enters it recursively.
			// Include cancelled requests whose shared upstream query may still be running.
			const ids = requests.snapshot().filter(r => r.serverId &&
				(r.state === 'loading' || (r.finishedAt != null && now - r.finishedAt < 60_000)))
				.map(r => r.serverId!).slice(0, 100);
			if (!ids.length) return;
			polling = true;
			const attemptController = new AbortController();
			const abort = () => attemptController.abort();
			controller.signal.addEventListener('abort', abort, { once: true });
			const timeout = setTimeout(abort, 10_000);
			try {
				const data = await serverActivity!(ids, attemptController.signal);
				if (instance && instance !== data.instance) server = {};
				instance = data.instance;
				const retained = new Set(requests.snapshot().map(r => r.serverId));
				server = { ...Object.fromEntries(Object.entries(server).filter(([id]) => retained.has(id))), ...Object.fromEntries(data.requests.map(r => [r.id, r])) };
				monitorError = '';
			} catch (error) {
				if (!controller.signal.aborted) monitorError = `Server status unavailable: ${error instanceof Error ? error.message : String(error)}`;
			} finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); polling = false; }
		}
		const poller = serverActivity ? setInterval(() => { void poll(); }, 1500) : undefined;
		if (serverActivity) void poll();
		return () => { unsubscribe(); clearTimeout(flush); clearInterval(ticker); clearInterval(poller); controller.abort(); };
	});
</script>

{#if visible}
	<div class="activity" class:floating class:one-line={display==='line'} style:top={floating?`${topInset}px`:undefined} data-display={display} data-testid="world-request-panel" data-requests={JSON.stringify(rows)}>
		<div class="summary-row">
		<button class="summary" class:error={systemError || counts.missing > 0} aria-expanded={expanded}
			onclick={() => setDisplay(expanded?'summary':'details')} data-testid="world-request-toggle">
			<span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
			<span class="line" role={systemError ? 'alert' : 'status'} data-testid="world-request-summary" title={system||progress?.overall||summary}>{display==='line'?(system||progress?.compact||progress?.overall||summary):summary}</span>
			{#if display!=='line' && system && (counts.loading || counts.queued || counts.retrying || counts.missing)}<span class="total">{counts.loading} loading · {counts.queued} queued{counts.retrying ? ` · ${counts.retrying} retrying` : ''}{counts.missing ? ` · ${counts.missing} missing` : ''}</span>{/if}
		</button>
		<select aria-label="Loading overlay size" value={display} onchange={e=>setDisplay(e.currentTarget.value)} data-testid="world-request-display">
			<option value="line">one line</option><option value="summary">summary</option><option value="details">details</option>
		</select>
		</div>
		{#if progress && display!=='line'}
			<div class="progress" data-testid="world-progress">
				<div class="overall" data-testid="world-progress-overall">{progress.overall}</div>
				<div class="step" data-testid="world-progress-step">{progress.step}{#if progress.restarts}<span class="restarts" data-testid="world-progress-restarts"> · {progress.restarts}</span>{/if}</div>
				{#if progress.bytes}<div class="step" data-testid="world-progress-bytes">{progress.bytes}
					{#if progress.rate}<span class="rate" class:idle={!assetsLoading} data-testid="world-network-rate" data-active={assetsLoading}
						title={assetsLoading?'Transfer rate while tracked assets are loading':'No asset downloads active'}> · {assetsLoading?progress.rate:'network idle'}</span>{/if}
				</div>{/if}
			</div>
		{/if}
		{#if expanded}
			<div class="body" data-testid="world-request-list">
				<div class="totals">{counts.loaded} loaded for this view · {counts.loading} loading · {counts.queued} queued · {counts.retrying} retrying · {counts.missing} missing
					<label><input type="checkbox" bind:checked={history} data-testid="world-request-history" /> include history ({counts.received} received)</label>
				</div>
				{#if monitorError}<p class="error" data-testid="world-request-monitor-error">{monitorError}</p>{/if}
				{#if system}<div class="row system" data-testid="world-request-system"><b>system</b><span>{system}</span></div>{/if}
				{#each ordered as r (r.id)}
					{@const observation = r.serverId ? server[r.serverId] : undefined}
					<div class="row" class:unwanted={!r.wanted && r.state !== 'loaded'} class:error={r.wanted && r.state === 'failed'} data-testid="world-request-row" data-kind={r.kind} data-state={r.state}>
						<div class="row-head"><b>{r.label}</b><span>{r.state}{r.state === 'retrying' ? ` in ${retryIn(r)}s` : ''} · {elapsed(r)}s{r.attempts ? ` · attempt ${r.attempts}` : ''}{r.state === 'loading' && elapsed(r) >= 30 ? ' · taking a while' : ''}</span></div>
						<div class="muted" title="Lower niceness numbers load first, subject to concurrency limits; niceness follows the view.">{r.wanted ? `desired · nice ${r.priority + 1}` : r.state === 'loaded' ? 'received' : 'no longer desired'}{r.reason ? ` · ${r.reason}` : ''}</div>
						{#if r.error}<div class="error">{r.error}</div>{/if}
						{#if observation}
							<div data-testid="world-request-server-stage">API: {observation.detail ?? observation.stage} · updated {Math.max(0, Math.floor(now / 1000 - observation.updated_at))}s ago</div>
							{#each observation.children as query (query.id)}
								<details class="query" data-testid="world-request-query"><summary>Overpass · {query.detail ?? query.stage}{query.bounds ? ` · ${query.bounds.map(v => v.toFixed(3)).join(', ')}` : ''}</summary>
									<div>{query.url} · attempt {query.attempts}{query.finished_at ? ' · finished' : ' · shared server work'}</div>
									<pre>{query.query}</pre>
								</details>
							{/each}
						{:else if serverActivity && r.state === 'loading' && (r.kind === 'map' || r.kind === 'labels' || r.kind === 'terrain')}
							<div class="muted">Awaiting API stage report</div>
						{/if}
						<details class="request"><summary>request URL</summary><code>{r.url}{r.detail ? ` · ${r.detail}` : ''}</code></details>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.activity { color: #eee; background: #131923ed; border: 1px solid #3a4658; border-radius: 5px; font: 12px system-ui, sans-serif; max-width: 760px; }
	.floating { position: absolute; top: 8px; left: 8px; right: 8px; z-index: 6; }
	.summary-row { display:flex; align-items:center; min-width:0; }
	.summary-row select { flex:none; max-width:7em; padding:2px 4px; margin:2px 4px 2px 0; font:inherit; color:inherit; background:#1d2633; border:1px solid #465367; border-radius:3px; }
	.summary { min-width:0; flex:1; display: flex; align-items: center; gap: 7px; width: 100%; color: inherit; background: transparent; border: 0; padding: 5px 8px; text-align: left; font: inherit; cursor: pointer; }
	.line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
	.one-line .summary.error .line { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.summary.error .line { overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }
	.total { white-space: nowrap; color: #aebcce; }
	.progress { padding: 0 8px 5px 22px; overflow-wrap: anywhere; }
	.overall { font-weight: 600; }
	.step { color: #aebcce; }
	.rate.idle { color: #737b89; }
	.restarts { color: #ffd27a; }
	.body { max-height: min(45vh, 420px); overflow: auto; overscroll-behavior: contain; border-top: 1px solid #3a4658; }
	.totals { padding: 8px; display: flex; gap: 12px; flex-wrap: wrap; color: #aebcce; }
	.row { display: block; padding: 7px 9px; border-top: 1px solid #2a3442; overflow-wrap: anywhere; }
	.row-head { display: flex; gap: 10px; justify-content: space-between; flex-wrap: wrap; }
	.row-head span, .muted { color: #aebcce; }
	.system { display: flex; gap: 10px; }
	.error { color: #ffac95; }
	.unwanted { opacity: .65; }
	details { margin-top: 4px; }
	summary { cursor: pointer; }
	pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
	code { font-size: 11px; }
</style>
