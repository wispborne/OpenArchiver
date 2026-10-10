<script lang="ts">
	import type { PageData } from './$types';
	import type { IJob } from '@open-archiver/types';
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '$lib/translations';
	import AutoRefresh from '$lib/components/custom/jobs/AutoRefresh.svelte';
	import JobList from '$lib/components/custom/jobs/JobList.svelte';
	import JobDetailDialog from '$lib/components/custom/jobs/JobDetailDialog.svelte';
	import QueueControls from '$lib/components/custom/jobs/QueueControls.svelte';
	import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-svelte';

	let { data }: { data: PageData } = $props();
	let queue = $derived(data.queue);
	let now = $state(Date.now());

	const tabs = [
		{ status: 'active', key: 'tab_active' },
		{ status: 'waiting', key: 'tab_waiting' },
		{ status: 'delayed', key: 'tab_delayed' },
		{ status: 'failed', key: 'tab_failed' },
		{ status: 'completed', key: 'tab_completed' },
	] as const;
	const count = (status: string) => {
		const c = queue.counts as unknown as Record<string, number | undefined>;
		return status === 'waiting' ? (c.waiting ?? 0) + (c.prioritized ?? 0) : (c[status] ?? 0);
	};

	const urlFor = (params: Record<string, string | null>) => {
		const url = new URL(page.url);
		for (const [k, v] of Object.entries(params)) {
			if (v === null) url.searchParams.delete(k);
			else url.searchParams.set(k, v);
		}
		return `${url.pathname}${url.search}`;
	};

	// The open job lives in the URL (?job=…), so a job can be linked to and the back button closes it.
	let detailId = $derived(page.url.searchParams.get('job'));
	let detailOpen = $state(false);
	$effect(() => {
		detailOpen = !!detailId;
	});
	const openJob = (job: IJob) =>
		goto(urlFor({ job: job.id ?? null }), { noScroll: true, keepFocus: true });
	$effect(() => {
		if (!detailOpen && detailId) {
			goto(urlFor({ job: null }), { noScroll: true, keepFocus: true, replaceState: true });
		}
	});
</script>

<svelte:head>
	<title>{$t(`app.jobs.queue_${queue.name}`)} - {$t('app.jobs.page_title')} - Open Archiver</title
	>
</svelte:head>

<div class="space-y-4">
	<a
		href="/dashboard/admin/jobs"
		class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
	>
		<ArrowLeft class="h-4 w-4" />
		{$t('app.jobs.page_title')}
	</a>

	<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
		<div class="space-y-1">
			<h1 class="flex flex-wrap items-center gap-2 text-2xl font-bold">
				{$t(`app.jobs.queue_${queue.name}`)}
				{#if queue.isPaused}
					<Badge variant="secondary">{$t('app.jobs.queue_paused')}</Badge>
				{/if}
			</h1>
			<p class="text-muted-foreground text-sm">
				{$t(`app.jobs.queue_${queue.name}_description`)}
			</p>
			<p class="flex items-center gap-2 text-sm">
				<span
					class="h-2 w-2 rounded-full {queue.workerAlive === false
						? 'bg-destructive'
						: 'bg-green-600'}"
				></span>
				{queue.workerAlive === false
					? $t('app.jobs.worker_not_running')
					: $t('app.jobs.worker_running')}
			</p>
		</div>
		<div class="flex flex-col items-start gap-2 sm:items-end">
			<QueueControls {queue} onChanged={() => invalidateAll()} />
			<AutoRefresh bind:now />
		</div>
	</div>

	{#if queue.workerAlive === false}
		<Alert.Root variant="destructive">
			<Alert.Description>{$t('app.jobs.worker_not_running_help')}</Alert.Description>
		</Alert.Root>
	{/if}
	{#if queue.isPaused}
		<Alert.Root>
			<Alert.Description>{$t('app.jobs.queue_paused_help')}</Alert.Description>
		</Alert.Root>
	{/if}

	<Card.Root>
		<Card.Header class="pb-3">
			<!-- Tabs as links: each status is its own URL, so it survives a reload and can be shared. -->
			<nav class="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label={$t('app.jobs.jobs')}>
				{#each tabs as tab}
					{@const n = count(tab.status)}
					{@const selected = data.status === tab.status}
					<a
						href={urlFor({ status: tab.status, page: null, job: null })}
						aria-current={selected ? 'page' : undefined}
						class="flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors {selected
							? 'bg-primary text-primary-foreground'
							: 'hover:bg-muted'}"
					>
						{$t(`app.jobs.${tab.key}`)}
						<span
							class="rounded-full px-1.5 text-xs tabular-nums {selected
								? 'bg-primary-foreground/20'
								: tab.status === 'failed' && n > 0
									? 'bg-destructive text-white'
									: 'bg-muted'}">{n.toLocaleString()}</span
						>
					</a>
				{/each}
			</nav>
		</Card.Header>
		<Card.Content class="space-y-3">
			{#if queue.jobs.length === 0}
				<p class="text-muted-foreground py-6 text-center text-sm">
					{$t(`app.jobs.empty_${data.status}`)}
				</p>
			{:else}
				<JobList jobs={queue.jobs} {now} onSelect={openJob} />
			{/if}

			{#if queue.pagination.totalPages > 1}
				<div class="flex items-center justify-between gap-2 text-sm">
					<span class="text-muted-foreground">
						{$t('app.jobs.page_of', {
							page: data.page,
							pages: queue.pagination.totalPages,
						} as any)}
						· {$t('app.jobs.jobs_total', {
							count: queue.pagination.totalJobs.toLocaleString(),
						} as any)}
					</span>
					<div class="flex gap-2">
						<Button
							size="sm"
							variant="outline"
							href={urlFor({ page: String(data.page - 1), job: null })}
							disabled={data.page <= 1}
							aria-label={$t('app.jobs.previous')}
						>
							<ChevronLeft class="h-4 w-4" />
						</Button>
						<Button
							size="sm"
							variant="outline"
							href={urlFor({ page: String(data.page + 1), job: null })}
							disabled={data.page >= queue.pagination.totalPages}
							aria-label={$t('app.jobs.next')}
						>
							<ChevronRight class="h-4 w-4" />
						</Button>
					</div>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<JobDetailDialog
	bind:open={detailOpen}
	queueName={queue.name}
	jobId={detailId}
	onChanged={() => invalidateAll()}
/>
