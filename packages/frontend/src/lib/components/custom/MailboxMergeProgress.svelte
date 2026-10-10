<script lang="ts">
	import type { MailboxMergeStatus } from '@open-archiver/types';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { api } from '$lib/api.client';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { t } from '$lib/translations';
	import { onDestroy } from 'svelte';

	let {
		sourceId,
		status,
		onFinished,
	}: {
		sourceId: string;
		/** As loaded with the page; polled from here while a run is in progress. */
		status: MailboxMergeStatus | null;
		/** Called once when a run this component watched finishes, to reload the page's data. */
		onFinished: () => void;
	} = $props();

	let current = $state<MailboxMergeStatus | null>(null);
	$effect(() => {
		current = status;
	});

	let active = $derived(current?.state === 'queued' || current?.state === 'running');

	// Merges are started from the mailbox table further down the page, so a banner appearing at the
	// top would go unseen. Brought into view when a run starts while the page is open; not on load,
	// where it is already near the top.
	let banner = $state<HTMLElement | null>(null);
	let wasActiveOnLoad: boolean | null = null;
	$effect(() => {
		const isActive = active;
		if (wasActiveOnLoad === null) {
			wasActiveOnLoad = isActive;
			return;
		}
		if (isActive && banner) {
			banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	});

	// Polled rather than pushed: the API has no event stream, and a merge reports progress per batch
	// of a few hundred rows, so a few seconds between looks loses nothing worth seeing.
	const POLL_MS = 3000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let now = $state(Date.now());

	const poll = async () => {
		try {
			const res = await api(`/ingestion-sources/${sourceId}/mailboxes/merge-status`);
			if (res.ok) {
				const next = (await res.json()) as MailboxMergeStatus | null;
				const wasActive = active;
				current = next;
				now = Date.now();
				if (wasActive && !(next?.state === 'queued' || next?.state === 'running')) {
					onFinished();
				}
			}
		} catch {
			// A missed poll is retried on the next tick.
		}
	};

	$effect(() => {
		if (!active) return;
		const tick = async () => {
			await poll();
			timer = setTimeout(tick, POLL_MS);
		};
		timer = setTimeout(tick, POLL_MS);
		return () => clearTimeout(timer);
	});
	onDestroy(() => clearTimeout(timer));

	// A finished run stays on record for weeks; once read, the banner can be put away. Remembered
	// per run (its finish time), so the next merge shows again. Storage can be unavailable, in which
	// case the dismissal lasts until the page reloads.
	const dismissKey = $derived(`mailbox-merge-dismissed:${sourceId}`);
	let dismissedAt = $state<string | null>(null);
	$effect(() => {
		try {
			dismissedAt = localStorage.getItem(dismissKey);
		} catch {
			dismissedAt = null;
		}
	});
	const dismiss = () => {
		dismissedAt = current?.finishedAt ?? '';
		try {
			localStorage.setItem(dismissKey, dismissedAt);
		} catch {
			// See above.
		}
	};
	let visible = $derived(
		!!current && (active || !current.finishedAt || current.finishedAt !== dismissedAt)
	);

	let percent = $derived.by(() => {
		const p = current?.progress;
		if (!p || p.total <= 0) return null;
		return Math.min(100, Math.round((p.moved / p.total) * 100));
	});

	let settleSeconds = $derived.by(() => {
		const until = current?.progress?.settleUntil;
		if (!until) return 0;
		return Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
	});

	/**
	 * Whether the running job has gone quiet for longer than it should.
	 *
	 * The worker heartbeat cannot answer this: it lives ten minutes, so a worker killed mid-run
	 * still reads as alive long after. The job's own reports can, in the phases that report often:
	 * a batch of moves takes seconds, and the settle wait has a known end. Removing duplicates
	 * reports nothing per deletion and can legitimately run for minutes, so it is not judged.
	 */
	const OVERDUE_MS = 60_000;
	let overdue = $derived.by(() => {
		const p = current?.progress;
		if (current?.state !== 'running' || !p?.reportedAt) return false;
		if (p.phase === 'removing_duplicates') return false;
		const since = p.phase === 'settling' && p.settleUntil ? p.settleUntil : p.reportedAt;
		return now - Date.parse(since) > OVERDUE_MS;
	});

	const fmt = (n: number) => n.toLocaleString();
	const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

	let title = $derived.by(() => {
		if (!current) return '';
		const names = { mailbox: current.mailbox, into: current.into ?? '' };
		const kind = current.kind;
		switch (current.state) {
			case 'queued':
			case 'running':
				return $t(`app.mailbox_merge.progress_title_${kind}`, names as any);
			case 'completed':
				return $t(`app.mailbox_merge.done_title_${kind}`, names as any);
			case 'failed':
				return $t(`app.mailbox_merge.failed_title_${kind}`, names as any);
			case 'interrupted':
				return $t(`app.mailbox_merge.interrupted_title_${kind}`, names as any);
		}
	});

	let retrying = $state(false);
	const retry = async () => {
		if (!current || retrying) return;
		retrying = true;
		try {
			const res =
				current.kind === 'merge'
					? await api(`/ingestion-sources/${sourceId}/mailboxes/merge`, {
							method: 'POST',
							body: JSON.stringify({
								from: current.mailbox,
								into: current.into,
								collapseDuplicates: current.collapseDuplicates,
							}),
						})
					: await api(`/ingestion-sources/${sourceId}/mailboxes/unmerge`, {
							method: 'POST',
							body: JSON.stringify({ mailbox: current.mailbox }),
						});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(body.message || `HTTP ${res.status}`);
			}
			await poll();
			onFinished();
		} catch (e) {
			setAlert({
				type: 'error',
				title: $t('app.mailbox_merge.retry_failed'),
				message: e instanceof Error ? e.message : String(e),
				duration: 6000,
				show: true,
			});
		} finally {
			retrying = false;
		}
	};
</script>

{#if current && visible}
	<div bind:this={banner} class="scroll-mt-24">
		<Alert.Root
			variant={current.state === 'failed' || current.state === 'interrupted'
				? 'destructive'
				: 'default'}
			aria-live="polite"
		>
			<Alert.Title class="break-all">{title}</Alert.Title>
			<Alert.Description class="w-full space-y-2">
				{#if current.state === 'queued'}
					<p>
						{current.workerAlive
							? $t('app.mailbox_merge.progress_queued')
							: $t('app.mailbox_merge.no_worker')}
					</p>
				{:else if current.state === 'running'}
					{@const p = current.progress}
					{#if !p}
						<p>{$t('app.mailbox_merge.progress_starting')}</p>
					{:else if p.phase === 'moving'}
						<p>
							{$t('app.mailbox_merge.progress_moving', {
								moved: fmt(p.moved),
								total: fmt(p.total),
							} as any)}
						</p>
					{:else if p.phase === 'settling' && settleSeconds === 0}
						<p>
							{$t('app.mailbox_merge.progress_settled', {
								moved: fmt(p.moved),
							} as any)}
						</p>
					{:else if p.phase === 'settling'}
						<p>
							{$t('app.mailbox_merge.progress_settling', {
								moved: fmt(p.moved),
								seconds: settleSeconds,
							} as any)}
						</p>
					{:else if p.phase === 'final_pass'}
						<p>
							{$t('app.mailbox_merge.progress_final_pass', {
								moved: fmt(p.moved),
							} as any)}
						</p>
					{:else}
						<p>
							{$t('app.mailbox_merge.progress_removing_duplicates', {
								moved: fmt(p.moved),
							} as any)}
						</p>
					{/if}
					{#if percent !== null}
						<Progress value={percent} max={100} class="h-2" />
					{/if}
					{#if overdue || !current.workerAlive}
						<p class="text-destructive">
							{$t('app.mailbox_merge.progress_worker_gone')}
						</p>
					{/if}
				{:else if current.state === 'completed' && current.result}
					<p>
						{$t('app.mailbox_merge.done_moved', {
							count: fmt(current.result.moved),
						} as any)}
						{#if current.collapseDuplicates}
							{$t('app.mailbox_merge.done_duplicates', {
								removed: fmt(current.result.duplicatesRemoved),
								kept: fmt(current.result.duplicatesKept),
							} as any)}
						{/if}
					</p>
				{:else}
					{#if current.error}
						<p class="break-words font-mono text-xs">{current.error}</p>
					{/if}
					<p>{$t(`app.mailbox_merge.retry_help_${current.kind}`)}</p>
				{/if}

				{#if !active}
					<div class="flex flex-wrap items-center gap-2 pt-1">
						{#if current.finishedAt}
							<span class="text-muted-foreground text-xs">
								{$t('app.mailbox_merge.finished_at', {
									time: fmtTime(current.finishedAt),
								} as any)}
							</span>
						{/if}
						<div class="ml-auto flex gap-2">
							{#if current.state === 'failed' || current.state === 'interrupted'}
								<Button size="sm" onclick={retry} disabled={retrying}>
									{$t('app.mailbox_merge.retry')}
								</Button>
							{/if}
							<Button size="sm" variant="outline" onclick={dismiss}>
								{$t('app.mailbox_merge.dismiss')}
							</Button>
						</div>
					</div>
				{/if}
			</Alert.Description>
		</Alert.Root>
	</div>
{/if}
