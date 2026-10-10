<script lang="ts">
	import type { ICleanupDuplicatesResponse, IDuplicateCountResponse } from '@open-archiver/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { api } from '$lib/api.client';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { t } from '$lib/translations';

	let {
		open = $bindable(false),
		sourceId,
		sourceName,
		inMergeGroup = false,
		onQueued,
	}: {
		open: boolean;
		sourceId: string;
		sourceName: string;
		/** The source has merged children or is one, so the sweep covers the whole group. */
		inMergeGroup?: boolean;
		onQueued?: () => void;
	} = $props();

	let counts = $state<IDuplicateCountResponse | null>(null);
	let countError = $state('');
	let isCounting = $state(false);
	let isSubmitting = $state(false);

	// Counted afresh each time the dialog opens, so the figure on screen is the one the user
	// confirms against, not one left over from before a sync or an earlier cleanup.
	let countSeq = 0;
	$effect(() => {
		if (!open) return;
		const seq = ++countSeq;
		counts = null;
		countError = '';
		isCounting = true;
		(async () => {
			try {
				const res = await api(`/ingestion-sources/${sourceId}/duplicates`);
				const body = await res.json();
				if (seq !== countSeq) return;
				if (!res.ok) {
					countError = body.message || $t('app.ingestions.dedupe_count_unavailable');
					return;
				}
				counts = body;
			} catch {
				if (seq === countSeq) countError = $t('app.ingestions.dedupe_count_unavailable');
			} finally {
				if (seq === countSeq) isCounting = false;
			}
		})();
	});

	// `deletionEnabled` is absent from servers older than the field; treat that as unknown and let
	// the cleanup request itself report the refusal.
	let deletionDisabled = $derived(counts?.deletionEnabled === false);
	let canConfirm = $derived(
		!!counts && counts.duplicates > 0 && !deletionDisabled && !isSubmitting
	);

	const confirm = async () => {
		if (!canConfirm) return;
		isSubmitting = true;
		try {
			const res = await api(`/ingestion-sources/${sourceId}/duplicates/cleanup`, {
				method: 'POST',
			});
			const body = await res.json();
			if (!res.ok) {
				throw new Error(body.message || $t('app.ingestions.dedupe_failed'));
			}
			const dispatch = body as ICleanupDuplicatesResponse;
			if (dispatch.alreadyRunning) {
				setAlert({
					type: 'warning',
					title: $t('app.ingestions.dedupe_already_running_title'),
					message: $t('app.ingestions.dedupe_already_running'),
					duration: 6000,
					show: true,
				});
			} else if (!dispatch.workerAlive) {
				setAlert({
					type: 'warning',
					title: $t('app.ingestions.dedupe_no_worker_title'),
					message: $t('app.ingestions.dedupe_no_worker'),
					duration: 8000,
					show: true,
				});
			} else {
				setAlert({
					type: 'success',
					title: $t('app.ingestions.dedupe_started'),
					message: $t('app.ingestions.dedupe_started_message'),
					duration: 6000,
					show: true,
				});
			}
			open = false;
			onQueued?.();
		} catch (e) {
			setAlert({
				type: 'error',
				title: $t('app.ingestions.dedupe_failed'),
				message: e instanceof Error ? e.message : String(e),
				duration: 6000,
				show: true,
			});
		} finally {
			isSubmitting = false;
		}
	};
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{$t('app.ingestions.dedupe_title_source')}</Dialog.Title>
			<Dialog.Description>
				{$t('app.ingestions.dedupe_description_source', { name: sourceName } as any)}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			{#if inMergeGroup}
				<p class="text-muted-foreground text-sm">
					{$t('app.ingestions.dedupe_merge_group')}
				</p>
			{/if}

			<dl class="divide-y rounded-md border text-sm">
				<div class="flex items-center justify-between gap-4 px-3 py-2">
					<dt>{$t('app.ingestions.dedupe_duplicates_found')}</dt>
					<dd class="font-semibold tabular-nums">
						{#if isCounting}
							<span class="text-muted-foreground font-normal"
								>{$t('app.ingestions.dedupe_counting')}…</span
							>
						{:else if counts}
							{counts.duplicates.toLocaleString()}
						{:else}
							<span class="text-muted-foreground font-normal"
								>{$t('app.ingestions.dedupe_count_unavailable')}</span
							>
						{/if}
					</dd>
				</div>
				{#if counts}
					<div class="flex items-center justify-between gap-4 px-3 py-2">
						<dt>{$t('app.ingestions.dedupe_groups_found')}</dt>
						<dd class="tabular-nums">{counts.groups.toLocaleString()}</dd>
					</div>
					{#if counts.contentDiffers}
						<div class="flex items-center justify-between gap-4 px-3 py-2">
							<dt>{$t('app.ingestions.dedupe_content_differs_found')}</dt>
							<dd class="tabular-nums">{counts.contentDiffers.toLocaleString()}</dd>
						</div>
					{/if}
					{#if counts.protected > 0}
						<div class="flex items-center justify-between gap-4 px-3 py-2">
							<dt>{$t('app.ingestions.dedupe_protected_found')}</dt>
							<dd class="tabular-nums">{counts.protected.toLocaleString()}</dd>
						</div>
					{/if}
				{/if}
			</dl>

			{#if countError}
				<p class="text-destructive text-sm">{countError}</p>
			{/if}

			{#if counts?.running}
				<Alert.Root>
					<Alert.Title>{$t('app.ingestions.dedupe_already_running_title')}</Alert.Title>
					<Alert.Description>{$t('app.ingestions.dedupe_running_note')}</Alert.Description
					>
				</Alert.Root>
			{/if}

			{#if deletionDisabled}
				<Alert.Root variant="destructive">
					<Alert.Title>{$t('app.ingestions.dedupe_deletion_disabled_title')}</Alert.Title>
					<Alert.Description
						>{$t('app.ingestions.dedupe_deletion_disabled')}</Alert.Description
					>
				</Alert.Root>
			{:else if counts && counts.duplicates === 0}
				<Alert.Root>
					<Alert.Title>{$t('app.ingestions.dedupe_nothing_found')}</Alert.Title>
					<Alert.Description
						>{$t('app.ingestions.dedupe_nothing_found_message')}</Alert.Description
					>
				</Alert.Root>
			{:else if counts}
				<ul class="text-muted-foreground ml-4 list-disc space-y-1 text-sm">
					<li>{$t('app.ingestions.dedupe_warning_keeps_one')}</li>
					<li>{$t('app.ingestions.dedupe_warning_content')}</li>
					<li>{$t('app.ingestions.dedupe_warning_files')}</li>
					<li>{$t('app.ingestions.dedupe_warning_background')}</li>
				</ul>
			{/if}
		</div>

		<Dialog.Footer class="gap-2 sm:justify-start">
			<Button type="button" variant="destructive" onclick={confirm} disabled={!canConfirm}>
				{isSubmitting
					? `${$t('app.ingestions.dedupe_removing')}…`
					: $t('app.ingestions.dedupe_confirm')}
			</Button>
			<Dialog.Close>
				<Button type="button" variant="secondary">{$t('app.ingestions.cancel')}</Button>
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
