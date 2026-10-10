<script lang="ts">
	import type { IJobDetail, MailboxMergeProgress } from '@open-archiver/types';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import JobStateBadge from './JobStateBadge.svelte';
	import { api } from '$lib/api.client';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { describeJob, jobDuration, jobLabel, jobPercent } from '$lib/jobs';
	import { t } from '$lib/translations';
	import { RotateCcw, Trash2 } from 'lucide-svelte';

	let {
		open = $bindable(false),
		queueName,
		jobId,
		onChanged,
	}: {
		open: boolean;
		queueName: string;
		jobId: string | null;
		/** Called after Retry or Remove, so the list behind the dialog can reload. */
		onChanged: () => void;
	} = $props();

	let job = $state<IJobDetail | null>(null);
	let missing = $state(false);
	let loading = $state(false);
	let busy = $state(false);
	let now = $state(Date.now());

	const load = async () => {
		if (!jobId) return;
		try {
			const res = await api(`/jobs/queues/${queueName}/jobs/${encodeURIComponent(jobId)}`);
			if (res.status === 404) {
				missing = true;
				job = null;
				return;
			}
			if (res.ok) {
				job = await res.json();
				missing = false;
				now = Date.now();
			}
		} catch {
			// Kept as it was; the next refresh tries again.
		}
	};

	$effect(() => {
		if (!open || !jobId) return;
		job = null;
		missing = false;
		loading = true;
		load().finally(() => (loading = false));
	});

	// Follows a job that is still going: progress and the log both grow while it runs.
	let live = $derived(
		!!job && ['active', 'waiting', 'prioritized', 'delayed'].includes(job.state)
	);
	$effect(() => {
		if (!open || !live) return;
		const timer = setInterval(load, 3000);
		return () => clearInterval(timer);
	});

	let logBox = $state<HTMLElement | null>(null);
	$effect(() => {
		// Keeps the newest line in view as the log grows.
		if (job?.logs.length && logBox) logBox.scrollTop = logBox.scrollHeight;
	});

	const act = async (action: 'retry' | 'remove') => {
		if (!job?.id || busy) return;
		busy = true;
		try {
			const path = `/jobs/queues/${queueName}/jobs/${encodeURIComponent(job.id)}`;
			const res = await api(action === 'retry' ? `${path}/retry` : path, {
				method: action === 'retry' ? 'POST' : 'DELETE',
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
			setAlert({
				type: 'success',
				title: body.message,
				message: '',
				duration: 4000,
				show: true,
			});
			onChanged();
			if (action === 'remove') {
				open = false;
			} else {
				await load();
			}
		} catch (e) {
			setAlert({
				type: 'error',
				title: $t('app.jobs.action_failed'),
				message: e instanceof Error ? e.message : String(e),
				duration: 6000,
				show: true,
			});
		} finally {
			busy = false;
		}
	};

	const json = (value: unknown) => JSON.stringify(value, null, 2);
	const fmtTime = (ms: number | undefined) => (ms ? new Date(ms).toLocaleString() : '—');

	let percent = $derived(job ? jobPercent(job.progress) : null);
	let mergeProgress = $derived(
		job?.progress && typeof job.progress === 'object' && 'phase' in job.progress
			? (job.progress as MailboxMergeProgress)
			: null
	);
	let hasResult = $derived(
		job?.returnValue !== undefined && job?.returnValue !== null && job?.state === 'completed'
	);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-3xl">
		<Dialog.Header class="border-b p-4 pr-12">
			<Dialog.Title class="flex flex-wrap items-center gap-2">
				{job ? jobLabel(job.name) : $t('app.jobs.detail_title', { id: jobId ?? '' } as any)}
				{#if job}
					<JobStateBadge state={job.state} />
				{/if}
			</Dialog.Title>
			{#if job}
				<Dialog.Description class="break-all">
					{describeJob(job) || job.name}
					<span class="text-muted-foreground/70 font-mono text-xs">· {job.id}</span>
				</Dialog.Description>
			{/if}
		</Dialog.Header>

		<div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-sm">
			{#if loading && !job}
				<p class="text-muted-foreground">…</p>
			{:else if missing}
				<p class="text-muted-foreground">{$t('app.jobs.detail_not_found')}</p>
			{:else if job}
				<section>
					<h3 class="mb-2 font-semibold">{$t('app.jobs.detail_overview')}</h3>
					<dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
						<dt class="text-muted-foreground">{$t('app.jobs.detail_queue')}</dt>
						<dd>{$t(`app.jobs.queue_${job.queueName}`)}</dd>
						{#if job.ingestionSourceId}
							<dt class="text-muted-foreground">{$t('app.jobs.col_source')}</dt>
							<dd>
								<a
									class="hover:underline"
									href="/dashboard/ingestions/{job.ingestionSourceId}"
									>{job.ingestionSourceName ?? job.ingestionSourceId}</a
								>
							</dd>
						{/if}
						<dt class="text-muted-foreground">{$t('app.jobs.detail_attempts')}</dt>
						<!-- A manual retry adds an attempt beyond the allowance, so "3 of 1" would read as a bug;
						     the allowance is shown only when the job has one worth mentioning. -->
						<dd>
							{job.attemptsMade}{(job.attemptsAllowed ?? 1) > 1
								? ` / ${job.attemptsAllowed}`
								: ''}
						</dd>
						<dt class="text-muted-foreground">{$t('app.jobs.detail_queued')}</dt>
						<dd>{fmtTime(job.timestamp)}</dd>
						<dt class="text-muted-foreground">{$t('app.jobs.detail_started')}</dt>
						<dd>{fmtTime(job.processedOn)}</dd>
						<dt class="text-muted-foreground">{$t('app.jobs.detail_finished')}</dt>
						<dd>{fmtTime(job.finishedOn)}</dd>
						{#if job.processedOn}
							<dt class="text-muted-foreground">{$t('app.jobs.detail_duration')}</dt>
							<dd>{jobDuration(job, now)}</dd>
						{/if}
					</dl>
				</section>

				{#if job.state === 'active' && (percent !== null || mergeProgress)}
					<section>
						<h3 class="mb-2 font-semibold">{$t('app.jobs.detail_progress')}</h3>
						{#if percent !== null}
							<div class="flex items-center gap-2">
								<Progress value={percent} max={100} class="h-2" />
								<span class="tabular-nums">{percent}%</span>
							</div>
						{/if}
						{#if mergeProgress}
							<p class="text-muted-foreground mt-1">
								{mergeProgress.moved.toLocaleString()} / {mergeProgress.total.toLocaleString()}
								· {$t(`app.jobs.phase_${mergeProgress.phase}`)}
							</p>
						{/if}
					</section>
				{/if}

				{#if job.state === 'failed'}
					<section>
						<h3 class="text-destructive mb-2 font-semibold">
							{$t('app.jobs.detail_error')}
						</h3>
						<p class="text-destructive break-words">{job.failedReason}</p>
						{#if job.stacktrace?.length}
							<details class="mt-2">
								<summary class="text-muted-foreground cursor-pointer text-xs">
									{$t('app.jobs.detail_stacktrace')}
								</summary>
								<pre
									class="bg-muted mt-2 max-h-60 overflow-auto rounded-md p-3 text-xs">{job.stacktrace.join(
										'\n\n'
									)}</pre>
							</details>
						{/if}
					</section>
				{/if}

				<section>
					<h3 class="mb-2 font-semibold">{$t('app.jobs.detail_logs')}</h3>
					{#if job.logs.length === 0}
						<p class="text-muted-foreground">{$t('app.jobs.detail_logs_empty')}</p>
					{:else}
						{#if job.logCount > job.logs.length}
							<p class="text-muted-foreground mb-1 text-xs">
								{$t('app.jobs.detail_logs_truncated', {
									shown: job.logs.length,
									total: job.logCount,
								} as any)}
							</p>
						{/if}
						<pre
							bind:this={logBox}
							class="bg-muted max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 font-mono text-xs">{job.logs.join(
								'\n'
							)}</pre>
					{/if}
				</section>

				{#if hasResult}
					<section>
						<h3 class="mb-2 font-semibold">{$t('app.jobs.detail_result')}</h3>
						<pre
							class="bg-muted max-h-60 overflow-auto rounded-md p-3 font-mono text-xs">{json(
								job.returnValue
							)}</pre>
					</section>
				{/if}

				<section>
					<h3 class="mb-2 font-semibold">{$t('app.jobs.detail_data')}</h3>
					<pre
						class="bg-muted max-h-60 overflow-auto rounded-md p-3 font-mono text-xs">{json(
							job.data
						)}</pre>
				</section>
			{/if}
		</div>

		{#if job}
			<Dialog.Footer
				class="flex-col items-stretch gap-2 border-t p-4 sm:flex-row sm:items-center"
			>
				{#if job.state === 'failed' && !job.canRetry}
					<p class="text-muted-foreground mr-auto text-xs">
						{$t('app.jobs.retry_ingestion_help')}
					</p>
				{/if}
				<div class="flex gap-2 sm:ml-auto">
					{#if job.canRetry}
						<Button onclick={() => act('retry')} disabled={busy}>
							<RotateCcw class="mr-2 h-4 w-4" />
							{$t('app.jobs.retry')}
						</Button>
					{/if}
					{#if job.canRemove}
						<Button variant="outline" onclick={() => act('remove')} disabled={busy}>
							<Trash2 class="mr-2 h-4 w-4" />
							{$t('app.jobs.remove')}
						</Button>
					{/if}
				</div>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
