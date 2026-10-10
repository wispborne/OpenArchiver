<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { t } from '$lib/translations';
	import { LoaderCircle } from 'lucide-svelte';

	let { state }: { state: string } = $props();

	const known = ['active', 'waiting', 'prioritized', 'delayed', 'failed', 'completed', 'paused'];
	let key = $derived(known.includes(state) ? state : 'unknown');
	let classes = $derived(
		{
			active: 'bg-blue-600 text-white hover:bg-blue-600',
			failed: 'bg-destructive text-white hover:bg-destructive',
			completed: 'bg-green-600 text-white hover:bg-green-600',
		}[key] ?? ''
	);
</script>

<Badge
	variant={key === 'active' || key === 'failed' || key === 'completed' ? 'default' : 'secondary'}
	class="gap-1 whitespace-nowrap {classes}"
>
	{#if key === 'active'}
		<LoaderCircle class="h-3 w-3 animate-spin" />
	{/if}
	{$t(`app.jobs.state_${key}`)}
</Badge>
