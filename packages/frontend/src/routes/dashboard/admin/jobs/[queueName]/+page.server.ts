import { api } from '$lib/server/api';
import { error, type NumericRange } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { IGetQueueJobsResponse, JobStatus } from '@open-archiver/types';

const STATUSES: JobStatus[] = ['active', 'waiting', 'delayed', 'failed', 'completed', 'paused'];
const PAGE_SIZE = 20;

export const load: PageServerLoad = async (event) => {
	const { queueName } = event.params;
	const requested = event.url.searchParams.get('status') as JobStatus | null;
	const status: JobStatus = requested && STATUSES.includes(requested) ? requested : 'active';
	const page = Math.max(1, parseInt(event.url.searchParams.get('page') || '1', 10) || 1);

	const response = await api(
		`/jobs/queues/${queueName}?status=${status}&page=${page}&limit=${PAGE_SIZE}`,
		event
	);
	if (!response.ok) {
		const responseText = await response.json().catch(() => ({}));
		throw error(
			response.status as NumericRange<400, 599>,
			responseText.message || 'Failed to fetch job queue details.'
		);
	}
	const queue: IGetQueueJobsResponse = await response.json();

	return { queue, status, page };
};
