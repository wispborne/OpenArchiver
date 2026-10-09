<script lang="ts">
	import type {
		MailboxMergeDispatch,
		MailboxMergePreview,
		MergeMailboxesDto,
	} from '@open-archiver/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { api } from '$lib/api.client';
	import { setAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import { t } from '$lib/translations';

	let {
		open = $bindable(false),
		sourceId,
		from,
		mailboxes,
		onMerged,
	}: {
		open: boolean;
		sourceId: string;
		/** The mailbox being merged away. */
		from: string;
		/** Every mailbox of the group, offered as merge targets. */
		mailboxes: string[];
		onMerged: () => void;
	} = $props();

	let into = $state('');
	let collapseDuplicates = $state(false);
	let preview = $state<MailboxMergePreview | null>(null);
	let previewError = $state('');
	let isPreviewing = $state(false);
	let isMerging = $state(false);

	let targets = $derived(mailboxes.filter((m) => m !== from));

	// A fresh dialog for each mailbox: nothing from the previous one carries over.
	$effect(() => {
		if (open) {
			into = '';
			collapseDuplicates = false;
			preview = null;
			previewError = '';
		}
	});

	// Previewed as the target is typed, so the counts and any refusal are on screen before the
	// merge button is. The sequence number drops answers to anything but the latest keystroke.
	let previewSeq = 0;
	$effect(() => {
		const target = into.trim();
		preview = null;
		previewError = '';
		if (!open || !target) {
			return;
		}
		const seq = ++previewSeq;
		const timer = setTimeout(async () => {
			isPreviewing = true;
			try {
				const query = new URLSearchParams({ from, into: target });
				const res = await api(
					`/ingestion-sources/${sourceId}/mailboxes/merge-preview?${query}`
				);
				const body = await res.json();
				if (seq !== previewSeq) return;
				if (!res.ok) {
					previewError = body.message || $t('app.mailbox_merge.preview_failed');
					return;
				}
				preview = body;
			} catch {
				if (seq === previewSeq) previewError = $t('app.mailbox_merge.preview_failed');
			} finally {
				if (seq === previewSeq) isPreviewing = false;
			}
		}, 300);
		return () => clearTimeout(timer);
	});

	const confirmMerge = async () => {
		if (!preview || preview.blockedReason) return;
		isMerging = true;
		try {
			const dto: MergeMailboxesDto = {
				from,
				into: into.trim(),
				collapseDuplicates: collapseDuplicates && preview.duplicateMessages > 0,
			};
			const res = await api(`/ingestion-sources/${sourceId}/mailboxes/merge`, {
				method: 'POST',
				body: JSON.stringify(dto),
			});
			const body = await res.json();
			if (!res.ok) {
				throw new Error(body.message || $t('app.mailbox_merge.merge_failed'));
			}
			const dispatch = body as MailboxMergeDispatch;
			setAlert({
				type: dispatch.workerAlive ? 'success' : 'warning',
				title: $t('app.mailbox_merge.merge_started'),
				message: dispatch.workerAlive ? '' : $t('app.mailbox_merge.no_worker'),
				duration: 5000,
				show: true,
			});
			open = false;
			onMerged();
		} catch (e) {
			setAlert({
				type: 'error',
				title: $t('app.mailbox_merge.merge_failed'),
				message: e instanceof Error ? e.message : String(e),
				duration: 5000,
				show: true,
			});
		} finally {
			isMerging = false;
		}
	};
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{$t('app.mailbox_merge.title')}</Dialog.Title>
			<Dialog.Description>
				{$t('app.mailbox_merge.description', { from } as any)}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<div class="space-y-2">
				<Label for="merge-into">{$t('app.mailbox_merge.into_label')}</Label>
				<Input
					id="merge-into"
					list="merge-into-options"
					autocomplete="off"
					placeholder={$t('app.mailbox_merge.into_placeholder')}
					bind:value={into}
				/>
				<datalist id="merge-into-options">
					{#each targets as target (target)}
						<option value={target}></option>
					{/each}
				</datalist>
			</div>

			{#if isPreviewing}
				<p class="text-muted-foreground text-sm">{$t('app.mailbox_merge.previewing')}</p>
			{:else if previewError}
				<p class="text-destructive text-sm">{previewError}</p>
			{:else if preview}
				{#if preview.blockedReason}
					<Alert.Root variant="destructive">
						<Alert.Title>{$t('app.mailbox_merge.blocked_title')}</Alert.Title>
						<Alert.Description>
							{$t(`app.mailbox_merge.blocked_${preview.blockedReason}`)}
						</Alert.Description>
					</Alert.Root>
				{:else}
					<ul class="text-muted-foreground ml-4 list-disc space-y-1 text-sm">
						<li>
							{$t('app.mailbox_merge.summary_move', {
								count: preview.emailsToMove.toLocaleString(),
								into: preview.into,
							} as any)}
						</li>
						{#if !preview.intoExists}
							<li>{$t('app.mailbox_merge.summary_rename')}</li>
						{/if}
						{#if preview.into !== into.trim().toLowerCase()}
							<li>
								{$t('app.mailbox_merge.summary_followed_alias', {
									into: preview.into,
								} as any)}
							</li>
						{/if}
						<li>{$t('app.mailbox_merge.summary_future')}</li>
						<li>{$t('app.mailbox_merge.summary_access')}</li>
						{#if preview.duplicateMessages > 0}
							<li>
								{$t('app.mailbox_merge.summary_duplicates', {
									count: preview.duplicateMessages.toLocaleString(),
								} as any)}
							</li>
						{/if}
					</ul>

					{#if preview.duplicateMessages > 0}
						<div class="flex items-start gap-2">
							<Checkbox
								id="collapse-duplicates"
								bind:checked={collapseDuplicates}
								disabled={!preview.deletionEnabled}
							/>
							<div class="space-y-1">
								<Label for="collapse-duplicates">
									{$t('app.mailbox_merge.collapse_label')}
								</Label>
								<p class="text-muted-foreground text-xs">
									{preview.deletionEnabled
										? $t('app.mailbox_merge.collapse_help')
										: $t('app.mailbox_merge.collapse_deletion_disabled')}
								</p>
							</div>
						</div>
					{/if}
				{/if}
			{/if}
		</div>

		<Dialog.Footer class="sm:justify-start">
			<Button
				type="button"
				onclick={confirmMerge}
				disabled={isMerging || isPreviewing || !preview || preview.blockedReason !== null}
			>
				{isMerging ? $t('app.mailbox_merge.merging') : $t('app.mailbox_merge.confirm')}
			</Button>
			<Dialog.Close>
				<Button type="button" variant="secondary">{$t('app.ingestions.cancel')}</Button>
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
