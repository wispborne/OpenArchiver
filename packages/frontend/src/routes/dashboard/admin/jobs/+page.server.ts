import { api } from '$lib/server/api';
import { error, type NumericRange } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type {
	AttachmentRepairStatus,
	IGetQueuesResponse,
	IJob,
	IQueueDetails,
} from '@open-archiver/types';

/** Running jobs shown per queue on the overview; the queue page lists the rest. */
const ACTIVE_LIMIT = 20;
const FAILED_LIMIT = 5;

export const load: PageServerLoad = async (event) => {
	const response = await api('/jobs/queues', event);
	if (!response.ok) {
		const responseText = await response.json().catch(() => ({}));
		throw error(
			response.status as NumericRange<400, 599>,
			responseText.message || 'Failed to fetch job queues.'
		);
	}
	const { queues }: IGetQueuesResponse = await response.json();

	// Each queue's running and recently failed jobs. A queue that fails to answer leaves its list
	// empty rather than failing the page; the counts above still show.
	const list = async (queue: string, status: string, limit: number) => {
		try {
			const res = await api(
				`/jobs/queues/${queue}?status=${status}&page=1&limit=${limit}`,
				event
			);
			if (!res.ok) return [];
			const details: IQueueDetails = await res.json();
			return details.jobs.map((job) => ({ ...job, queueName: queue }));
		} catch {
			return [];
		}
	};
	const [active, failed] = await Promise.all([
		Promise.all(queues.map((q) => list(q.name, 'active', ACTIVE_LIMIT))),
		Promise.all(
			queues.map((q) => (q.counts.failed > 0 ? list(q.name, 'failed', FAILED_LIMIT) : []))
		),
	]);

	const byRecent = (a: IJob, b: IJob) =>
		(b.finishedOn ?? b.processedOn ?? b.timestamp) -
		(a.finishedOn ?? a.processedOn ?? a.timestamp);

	// Optional: the page works without it, it just can't show the maintenance card's status.
	let attachmentRepair: AttachmentRepairStatus | null = null;
	try {
		const res = await api('/jobs/maintenance/attachment-repair', event);
		if (res.ok) attachmentRepair = await res.json();
	} catch {
		// Left null.
	}

	return {
		queues,
		active: active.flat().sort(byRecent),
		failed: failed.flat().sort(byRecent).slice(0, 8),
		attachmentRepair,
	};
};
