<script lang="ts">
	import type { PageData } from './$types';
	import type { IJob, IQueueCounts } from '@open-archiver/types';
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { invalidateAll } from '$app/navigation';
	import { t } from '$lib/translations';
	import AutoRefresh from '$lib/components/custom/jobs/AutoRefresh.svelte';
	import JobList from '$lib/components/custom/jobs/JobList.svelte';
	import JobDetailDialog from '$lib/components/custom/jobs/JobDetailDialog.svelte';
	import QueueControls from '$lib/components/custom/jobs/QueueControls.svelte';
	import AttachmentRepairCard from '$lib/components/custom/jobs/AttachmentRepairCard.svelte';
	import { Database, Inbox } from 'lucide-svelte';

	let { data }: { data: PageData } = $props();
	let now = $state(Date.now());

	type ListedJob = IJob & { queueName: string };

	let detailOpen = $state(false);
	let detailQueue = $state('');
	let detailId = $state<string | null>(null);
	const openJob = (job: IJob) => {
		detailQueue = (job as ListedJob).queueName;
		detailId = job.id ?? null;
		detailOpen = true;
	};
	const queueOf = (job: IJob) => $t(`app.jobs.queue_${(job as ListedJob).queueName}`);

	// Counts in the order a person reads a queue's state: what is happening, what is next, what
	// went wrong, what is done.
	const chips = [
		{ status: 'active', key: 'tab_active' },
		{ status: 'waiting', key: 'tab_waiting' },
		{ status: 'delayed', key: 'tab_delayed' },
		{ status: 'failed', key: 'tab_failed' },
		{ status: 'completed', key: 'tab_completed' },
	] as const;
	const count = (counts: IQueueCounts, status: string) => {
		const c = counts as unknown as Record<string, number | undefined>;
		return status === 'waiting' ? (c.waiting ?? 0) + (c.prioritized ?? 0) : (c[status] ?? 0);
	};
</script>

<svelte:head>
	<title>{$t('app.jobs.page_title')} - Open Archiver</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
		<div class="space-y-1">
			<h1 class="text-2xl font-bold">{$t('app.jobs.page_title')}</h1>
			<p class="text-muted-foreground max-w-2xl text-sm">{$t('app.jobs.page_description')}</p>
		</div>
		<AutoRefresh bind:now />
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		{#each data.queues as queue (queue.name)}
			<Card.Root>
				<Card.Header class="space-y-3">
					<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div class="flex items-start gap-3">
							{#if queue.name === 'ingestion'}
								<Inbox class="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />
							{:else}
								<Database class="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />
							{/if}
							<div class="space-y-1">
								<Card.Title class="flex flex-wrap items-center gap-2">
									{$t(`app.jobs.queue_${queue.name}`)}
									{#if queue.isPaused}
										<Badge variant="secondary"
											>{$t('app.jobs.queue_paused')}</Badge
										>
									{/if}
								</Card.Title>
								<Card.Description>
									{$t(`app.jobs.queue_${queue.name}_description`)}
								</Card.Description>
							</div>
						</div>
						<QueueControls {queue} onChanged={() => invalidateAll()} />
					</div>
					<div class="flex items-center gap-2 text-sm">
						<span
							class="h-2 w-2 rounded-full {queue.workerAlive === false
								? 'bg-destructive'
								: 'bg-green-600'}"
						></span>
						{queue.workerAlive === false
							? $t('app.jobs.worker_not_running')
							: $t('app.jobs.worker_running')}
					</div>
				</Card.Header>
				<Card.Content class="space-y-3">
					{#if queue.workerAlive === false}
						<Alert.Root variant="destructive">
							<Alert.Description
								>{$t('app.jobs.worker_not_running_help')}</Alert.Description
							>
						</Alert.Root>
					{/if}
					{#if queue.isPaused}
						<Alert.Root>
							<Alert.Description>{$t('app.jobs.queue_paused_help')}</Alert.Description
							>
						</Alert.Root>
					{/if}
					<div class="grid grid-cols-3 gap-2 sm:grid-cols-5">
						{#each chips as chip}
							{@const n = count(queue.counts, chip.status)}
							<a
								href="/dashboard/admin/jobs/{queue.name}?status={chip.status}"
								class="hover:bg-muted rounded-md border p-2 text-center transition-colors"
							>
								<div
									class="text-lg font-semibold tabular-nums {chip.status ===
										'failed' && n > 0
										? 'text-destructive'
										: chip.status === 'active' && n > 0
											? 'text-blue-600'
											: ''}"
								>
									{n.toLocaleString()}
								</div>
								<div class="text-muted-foreground text-xs">
									{$t(`app.jobs.${chip.key}`)}
								</div>
							</a>
						{/each}
					</div>
					<Button variant="outline" size="sm" href="/dashboard/admin/jobs/{queue.name}">
						{$t('app.jobs.view_jobs')}
					</Button>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>{$t('app.jobs.running_now')}</Card.Title>
		</Card.Header>
		<Card.Content>
			{#if data.active.length === 0}
				<p class="text-muted-foreground text-sm">{$t('app.jobs.nothing_running')}</p>
			{:else}
				<JobList jobs={data.active} {now} showQueue {queueOf} onSelect={openJob} />
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>{$t('app.jobs.recent_failures')}</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-3">
			{#if data.failed.length === 0}
				<p class="text-muted-foreground text-sm">{$t('app.jobs.no_recent_failures')}</p>
			{:else}
				<JobList jobs={data.failed} {now} showQueue {queueOf} onSelect={openJob} />
				<div class="flex flex-wrap gap-2">
					{#each data.queues.filter((q) => q.counts.failed > 0) as queue}
						<Button
							variant="link"
							size="sm"
							class="px-0"
							href="/dashboard/admin/jobs/{queue.name}?status=failed"
						>
							{$t('app.jobs.see_all')}: {$t(`app.jobs.queue_${queue.name}`)} ({queue
								.counts.failed})
						</Button>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
	<section class="space-y-3">
		<h2 class="text-lg font-semibold">{$t('app.jobs.maintenance')}</h2>
		<AttachmentRepairCard status={data.attachmentRepair} onChanged={() => invalidateAll()} />
	</section>
</div>

<JobDetailDialog
	bind:open={detailOpen}
	queueName={detailQueue}
	jobId={detailId}
	onChanged={() => invalidateAll()}
/>
