<script lang="ts">
	import type {
		IGetQueuesResponse,
		IJob,
		IQueueDetails,
		IQueueOverview,
	} from '@open-archiver/types';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { api } from '$lib/api.client';
	import { goto } from '$app/navigation';
	import { t } from '$lib/translations';
	import JobList from './JobList.svelte';
	import { onMount } from 'svelte';
	import { authStore } from '$lib/stores/auth.store';

	/** Running jobs listed here; the Jobs page has the rest. */
	const MAX_RUNNING = 5;
	const POLL_MS = 5000;

	type ListedJob = IJob & { queueName: string };

	let queues = $state<IQueueOverview[] | null>(null);
	let running = $state<ListedJob[]>([]);
	// The jobs API is for Super Admins only. Anyone else gets a 403, and the card stays hidden
	// rather than showing an error about a page they can't open. Only a 403 hides it: a 401 means
	// the request went out before this browser had its token (see below), not a lack of access.
	let hidden = $state(false);
	let now = $state(Date.now());

	const load = async () => {
		try {
			const res = await api('/jobs/queues');
			if (res.status === 403) {
				hidden = true;
				return;
			}
			if (!res.ok) return;
			const data: IGetQueuesResponse = await res.json();
			const lists = await Promise.all(
				data.queues
					.filter((q) => q.counts.active > 0)
					.map(async (q) => {
						const r = await api(
							`/jobs/queues/${q.name}?status=active&page=1&limit=${MAX_RUNNING}`
						);
						if (!r.ok) return [];
						const details: IQueueDetails = await r.json();
						return details.jobs.map((job) => ({ ...job, queueName: q.name }));
					})
			);
			queues = data.queues;
			running = lists
				.flat()
				.sort((a, b) => (a.processedOn ?? a.timestamp) - (b.processedOn ?? b.timestamp))
				.slice(0, MAX_RUNNING);
			now = Date.now();
		} catch {
			// Kept as it was; the next poll tries again.
		}
	};

	// Polls only this card, so the dashboard's charts are not reloaded every few seconds. Skipped
	// while the tab is hidden.
	// The root layout hands the session token to the client-side API helper in an effect, and
	// Svelte runs a child's mount before its parent's effects. Loading straight away on a fresh
	// page sent the first request without a token, so the first load waits for one.
	let started = false;
	$effect(() => {
		if (!started && $authStore.accessToken) {
			started = true;
			load();
		}
	});

	onMount(() => {
		const poll = setInterval(() => {
			if (started && !hidden && document.visibilityState === 'visible') load();
		}, POLL_MS);
		const clock = setInterval(() => (now = Date.now()), 1000);
		return () => {
			clearInterval(poll);
			clearInterval(clock);
		};
	});

	const waiting = (q: IQueueOverview) => q.counts.waiting + (q.counts.prioritized ?? 0);
	let totalRunning = $derived(queues?.reduce((n, q) => n + q.counts.active, 0) ?? 0);
	const openJob = (job: IJob) =>
		goto(`/dashboard/admin/jobs/${(job as ListedJob).queueName}?status=active&job=${job.id}`);
	const queueOf = (job: IJob) => $t(`app.jobs.queue_${(job as ListedJob).queueName}`);
</script>

{#if !hidden && queues}
	<Card.Root>
		<Card.Header class="flex flex-row items-center justify-between gap-2 space-y-0">
			<Card.Title>{$t('app.jobs.page_title')}</Card.Title>
			<Button variant="outline" size="sm" href="/dashboard/admin/jobs">
				{$t('app.dashboard_page.jobs_open')}
			</Button>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="grid gap-3 sm:grid-cols-2">
				{#each queues as queue (queue.name)}
					<div class="space-y-2 rounded-md border p-3">
						<div class="flex flex-wrap items-center gap-2">
							<span
								class="h-2 w-2 rounded-full {queue.workerAlive === false
									? 'bg-destructive'
									: 'bg-green-600'}"
								title={queue.workerAlive === false
									? $t('app.jobs.worker_not_running')
									: $t('app.jobs.worker_running')}
							></span>
							<span class="font-medium">{$t(`app.jobs.queue_${queue.name}`)}</span>
							{#if queue.isPaused}
								<Badge variant="secondary">{$t('app.jobs.queue_paused')}</Badge>
							{/if}
							{#if queue.workerAlive === false}
								<span class="text-destructive text-xs"
									>{$t('app.jobs.worker_not_running')}</span
								>
							{/if}
						</div>
						<div class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
							<a
								class="hover:underline"
								href="/dashboard/admin/jobs/{queue.name}?status=active"
							>
								<span
									class="font-semibold tabular-nums {queue.counts.active > 0
										? 'text-blue-600'
										: ''}">{queue.counts.active.toLocaleString()}</span
								>
								<span class="text-muted-foreground"
									>{$t('app.jobs.tab_active')}</span
								>
							</a>
							<a
								class="hover:underline"
								href="/dashboard/admin/jobs/{queue.name}?status=waiting"
							>
								<span class="font-semibold tabular-nums"
									>{waiting(queue).toLocaleString()}</span
								>
								<span class="text-muted-foreground"
									>{$t('app.jobs.tab_waiting')}</span
								>
							</a>
							<a
								class="hover:underline"
								href="/dashboard/admin/jobs/{queue.name}?status=failed"
							>
								<span
									class="font-semibold tabular-nums {queue.counts.failed > 0
										? 'text-destructive'
										: ''}">{queue.counts.failed.toLocaleString()}</span
								>
								<span class="text-muted-foreground"
									>{$t('app.jobs.tab_failed')}</span
								>
							</a>
						</div>
					</div>
				{/each}
			</div>

			{#if running.length > 0}
				<JobList jobs={running} {now} showQueue {queueOf} onSelect={openJob} />
				{#if totalRunning > running.length}
					<p class="text-muted-foreground text-xs">
						{$t('app.dashboard_page.jobs_more_running', {
							count: (totalRunning - running.length).toLocaleString(),
						} as any)}
					</p>
				{/if}
			{:else}
				<p class="text-muted-foreground text-sm">{$t('app.jobs.nothing_running')}</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
