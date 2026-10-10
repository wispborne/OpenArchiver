<script lang="ts">
	import type { AttachmentRepairStatus } from '@open-archiver/types';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { api } from '$lib/api.client';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { t } from '$lib/translations';
	import { Wrench } from 'lucide-svelte';

	let {
		status,
		onChanged,
	}: {
		/** As loaded with the page, which refreshes it while the page is open. */
		status: AttachmentRepairStatus | null;
		onChanged: () => void;
	} = $props();

	let busy = $state(false);
	let active = $derived(status?.state === 'queued' || status?.state === 'running');
	let percent = $derived(
		status?.progress && status.progress.total > 0
			? Math.min(100, Math.round((status.progress.done / status.progress.total) * 100))
			: null
	);
	const fmt = (n: number) => n.toLocaleString();

	const start = async () => {
		if (busy) return;
		busy = true;
		try {
			const res = await api('/jobs/maintenance/attachment-repair', { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
			setAlert({
				type: body.workerAlive === false ? 'warning' : 'success',
				title: body.message,
				message: body.workerAlive === false ? $t('app.jobs.worker_not_running_help') : '',
				duration: 5000,
				show: true,
			});
			onChanged();
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
</script>

<Card.Root>
	<Card.Header
		class="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between"
	>
		<div class="flex items-start gap-3">
			<Wrench class="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />
			<div class="space-y-1">
				<Card.Title>{$t('app.jobs.repair_title')}</Card.Title>
				<Card.Description class="max-w-2xl"
					>{$t('app.jobs.repair_description')}</Card.Description
				>
			</div>
		</div>
		<Button size="sm" variant="outline" onclick={start} disabled={busy || active}>
			{$t('app.jobs.repair_start')}
		</Button>
	</Card.Header>
	{#if status}
		<Card.Content class="space-y-2 text-sm">
			{#if active}
				{#if status.progress}
					<div class="flex items-center gap-2">
						<Progress value={percent ?? 0} max={100} class="h-2" />
						<span class="text-muted-foreground tabular-nums">{percent ?? 0}%</span>
					</div>
					<p class="text-muted-foreground">
						{$t('app.jobs.repair_progress', {
							done: fmt(status.progress.done),
							total: fmt(status.progress.total),
							missing: fmt(status.progress.missing),
							repaired: fmt(status.progress.repaired),
						} as any)}
					</p>
				{:else}
					<p class="text-muted-foreground">
						{status.workerAlive
							? $t('app.jobs.repair_queued')
							: $t('app.jobs.worker_not_running_help')}
					</p>
				{/if}
			{:else if status.state === 'completed' && status.result}
				{@const r = status.result}
				<p>
					{$t('app.jobs.repair_done', {
						checked: fmt(r.checked),
						missing: fmt(r.missing),
						repaired: fmt(r.repaired),
					} as any)}
				</p>
				{#if r.unreferenced + r.notFoundInEmail + r.failed > 0}
					<p class="text-muted-foreground">
						{$t('app.jobs.repair_left', {
							unreferenced: fmt(r.unreferenced),
							notFound: fmt(r.notFoundInEmail),
							failed: fmt(r.failed),
						} as any)}
					</p>
				{/if}
				{#if r.emailsAffected > 0}
					<p class="text-destructive">
						{$t('app.jobs.repair_affected', { count: fmt(r.emailsAffected) } as any)}
					</p>
				{/if}
				{#if r.ownerBackfilled > 0 || r.emailsReindexed > 0}
					<p class="text-muted-foreground">
						{$t('app.jobs.repair_extra', {
							owners: fmt(r.ownerBackfilled),
							emails: fmt(r.emailsReindexed),
						} as any)}
					</p>
				{/if}
			{:else}
				<p class="text-destructive">
					{status.state === 'interrupted'
						? $t('app.jobs.repair_interrupted')
						: $t('app.jobs.repair_failed', { error: status.error ?? '' } as any)}
				</p>
			{/if}
			{#if status.finishedAt && !active}
				<p class="text-muted-foreground text-xs">
					{$t('app.mailbox_merge.finished_at', {
						time: new Date(status.finishedAt).toLocaleString(),
					} as any)}
				</p>
			{/if}
		</Card.Content>
	{/if}
</Card.Root>
