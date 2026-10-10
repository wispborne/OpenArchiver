<script lang="ts">
	import type { IJob } from '@open-archiver/types';
	import { Progress } from '$lib/components/ui/progress';
	import JobStateBadge from './JobStateBadge.svelte';
	import { describeJob, jobDuration, jobLabel, jobPercent, timeAgo } from '$lib/jobs';
	import { t } from '$lib/translations';
	import { ChevronRight } from 'lucide-svelte';

	let {
		jobs,
		now,
		showQueue = false,
		queueOf = () => '',
		onSelect,
	}: {
		jobs: IJob[];
		/** Passed in so every row's relative times tick together with the page's refresh. */
		now: number;
		/** Shows which queue each job belongs to, for lists that mix both. */
		showQueue?: boolean;
		queueOf?: (job: IJob) => string;
		onSelect: (job: IJob) => void;
	} = $props();

	const when = (job: IJob) => {
		if (job.finishedOn)
			return $t('app.jobs.finished_ago', { time: timeAgo(job.finishedOn, now) } as any);
		if (job.processedOn)
			return $t('app.jobs.started_ago', { time: timeAgo(job.processedOn, now) } as any);
		return $t('app.jobs.queued_ago', { time: timeAgo(job.timestamp, now) } as any);
	};
</script>

<!-- A list of buttons rather than a table: every row opens the same detail view, and at phone
     width a table's columns had nowhere to go. -->
<ul class="divide-y rounded-md border">
	{#each jobs as job (job.id)}
		{@const percent = jobPercent(job.progress)}
		{@const detail = describeJob(job)}
		{@const duration = jobDuration(job, now)}
		{@const phase =
			job.progress && typeof job.progress === 'object' && 'phase' in job.progress
				? (job.progress as { phase: string }).phase
				: null}
		<li>
			<button
				type="button"
				class="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
				onclick={() => onSelect(job)}
			>
				<div class="min-w-0 flex-1 space-y-1">
					<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span class="font-medium">{jobLabel(job.name)}</span>
						{#if detail}
							<span class="text-muted-foreground truncate text-sm">{detail}</span>
						{/if}
					</div>
					<div class="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
						{#if showQueue}
							<span>{queueOf(job)}</span>
						{/if}
						{#if job.ingestionSourceName}
							<span>{job.ingestionSourceName}</span>
						{/if}
						<span
							title={new Date(
								job.finishedOn ?? job.processedOn ?? job.timestamp
							).toLocaleString()}>{when(job)}</span
						>
						{#if duration}
							<span>{duration}</span>
						{/if}
						{#if (job.attemptsAllowed ?? 1) > 1}
							<span>
								{$t('app.jobs.attempt', {
									made: Math.max(job.attemptsMade, 1),
									allowed: job.attemptsAllowed,
								} as any)}
							</span>
						{/if}
					</div>
					{#if job.state === 'failed' && job.failedReason}
						<p class="text-destructive line-clamp-2 text-xs">{job.failedReason}</p>
					{/if}
					{#if job.state === 'active' && percent !== null}
						<div class="flex items-center gap-2 pt-0.5">
							<Progress value={percent} max={100} class="h-1.5 max-w-60" />
							<span class="text-muted-foreground text-xs tabular-nums"
								>{percent}%</span
							>
							{#if phase}
								<!-- A merge sits at 100% through its wait and final pass; without the
								     phase the bar reads as stuck. -->
								<span class="text-muted-foreground truncate text-xs">
									{$t(`app.jobs.phase_${phase}`)}
								</span>
							{/if}
						</div>
					{/if}
				</div>
				<JobStateBadge state={job.state} />
				<ChevronRight class="text-muted-foreground h-4 w-4 shrink-0" />
			</button>
		</li>
	{/each}
</ul>
