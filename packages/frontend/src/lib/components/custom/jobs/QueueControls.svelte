<script lang="ts">
	import type { IQueueOverview } from '@open-archiver/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { api } from '$lib/api.client';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { t } from '$lib/translations';
	import { MoreHorizontal, Pause, Play } from 'lucide-svelte';

	let {
		queue,
		onChanged,
	}: {
		queue: IQueueOverview;
		/** Called after any action succeeds, so the page can reload. */
		onChanged: () => void;
	} = $props();

	let busy = $state(false);
	let confirmPause = $state(false);
	let confirmClear = $state<'completed' | 'failed' | null>(null);
	let confirmClearOpen = $state(false);

	let queueLabel = $derived($t(`app.jobs.queue_${queue.name}`));

	const run = async (path: string, init: RequestInit, onBody?: (body: any) => string) => {
		if (busy) return;
		busy = true;
		try {
			const res = await api(`/jobs/queues/${queue.name}/${path}`, init);
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
			setAlert({
				type: 'success',
				title: onBody ? onBody(body) : body.message,
				message: '',
				duration: 4000,
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

	const pause = async () => {
		confirmPause = false;
		await run('pause', { method: 'POST' });
	};
	const resume = () => run('resume', { method: 'POST' });
	const retryAll = () => run('retry-failed', { method: 'POST' });
	const clear = async () => {
		const state = confirmClear;
		confirmClearOpen = false;
		if (!state) return;
		await run('clean', { method: 'POST', body: JSON.stringify({ state }) }, (body) =>
			$t('app.jobs.cleared', { count: body.removed ?? 0 } as any)
		);
	};
	const askClear = (state: 'completed' | 'failed') => {
		confirmClear = state;
		confirmClearOpen = true;
	};
</script>

<div class="flex items-center gap-2">
	{#if queue.isPaused}
		<Button size="sm" onclick={resume} disabled={busy}>
			<Play class="mr-2 h-4 w-4" />
			{$t('app.jobs.resume')}
		</Button>
	{:else}
		<Button size="sm" variant="outline" onclick={() => (confirmPause = true)} disabled={busy}>
			<Pause class="mr-2 h-4 w-4" />
			{$t('app.jobs.pause')}
		</Button>
	{/if}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} size="sm" variant="ghost" class="h-8 w-8 p-0">
					<span class="sr-only">{$t('app.jobs.queue_actions')}</span>
					<MoreHorizontal class="h-4 w-4" />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end">
			{#if queue.name === 'indexing'}
				<DropdownMenu.Item onclick={retryAll} disabled={queue.counts.failed === 0}>
					{$t('app.jobs.retry_all_failed')}
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
			{/if}
			<DropdownMenu.Item
				onclick={() => askClear('completed')}
				disabled={queue.counts.completed === 0}
			>
				{$t('app.jobs.clear_completed')}
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onclick={() => askClear('failed')}
				disabled={queue.counts.failed === 0}
			>
				{$t('app.jobs.clear_failed')}
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>

<Dialog.Root bind:open={confirmPause}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title
				>{$t('app.jobs.pause_confirm_title', { queue: queueLabel } as any)}</Dialog.Title
			>
			<Dialog.Description>{$t('app.jobs.pause_confirm_body')}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="gap-2 sm:justify-start">
			<Button onclick={pause} disabled={busy}>{$t('app.jobs.pause')}</Button>
			<Dialog.Close>
				<Button variant="secondary">{$t('app.jobs.cancel')}</Button>
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={confirmClearOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>
				{confirmClear ? $t(`app.jobs.clear_confirm_title_${confirmClear}`) : ''}
			</Dialog.Title>
			<Dialog.Description>{$t('app.jobs.clear_confirm_body')}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="gap-2 sm:justify-start">
			<Button variant="destructive" onclick={clear} disabled={busy}
				>{$t('app.jobs.clear')}</Button
			>
			<Dialog.Close>
				<Button variant="secondary">{$t('app.jobs.cancel')}</Button>
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
