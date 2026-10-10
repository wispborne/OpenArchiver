<script lang="ts">
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import { Button } from '$lib/components/ui/button';
	import { invalidateAll } from '$app/navigation';
	import { t } from '$lib/translations';
	import { RefreshCw } from 'lucide-svelte';
	import { onMount } from 'svelte';

	let {
		now = $bindable(Date.now()),
		intervalMs = 5000,
	}: {
		/** Ticks every second, for relative times on the page. */
		now?: number;
		intervalMs?: number;
	} = $props();

	const STORAGE_KEY = 'jobs-auto-refresh';
	let enabled = $state(true);
	let refreshing = $state(false);
	let lastUpdated = $state(Date.now());

	onMount(() => {
		try {
			enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
		} catch {
			// Storage unavailable: keep the default.
		}
		const clock = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(clock);
	});

	const refresh = async () => {
		if (refreshing) return;
		refreshing = true;
		try {
			await invalidateAll();
			lastUpdated = Date.now();
		} finally {
			refreshing = false;
		}
	};

	$effect(() => {
		if (!enabled) return;
		// Skipped while the tab is hidden: nobody is watching, and every tick reloads the page data.
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') refresh();
		}, intervalMs);
		return () => clearInterval(timer);
	});

	const toggle = (on: boolean) => {
		enabled = on;
		try {
			localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
		} catch {
			// See above.
		}
	};
</script>

<div class="flex flex-wrap items-center gap-3 text-sm">
	<div class="flex items-center gap-2">
		<Switch id="jobs-auto-refresh" checked={enabled} onCheckedChange={toggle} />
		<Label for="jobs-auto-refresh">{$t('app.jobs.auto_refresh')}</Label>
	</div>
	<span class="text-muted-foreground text-xs tabular-nums">
		{$t('app.jobs.updated_ago', {
			seconds: Math.max(0, Math.round((now - lastUpdated) / 1000)),
		} as any)}
	</span>
	<Button size="sm" variant="ghost" onclick={refresh} disabled={refreshing}>
		<RefreshCw class="mr-1 h-4 w-4 {refreshing ? 'animate-spin' : ''}" />
		{$t('app.jobs.refresh')}
	</Button>
</div>
