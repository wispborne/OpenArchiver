<script lang="ts">
	import * as Chart from '$lib/components/ui/chart/index.js';
	import { BarChart } from 'layerchart';
	import type { TopSender } from '@open-archiver/types';
	import type { ChartConfig } from '$lib/components/ui/chart';
	import { niceAxisMax } from '$lib/utils';
	import { t } from '$lib/translations';
	import { goto } from '$app/navigation';
	import { searchUrl } from '$lib/ingestionActions';

	export let data: TopSender[];

	// Show the resolved display name when known, falling back to the address (#413). The address
	// rides along so a click can search by it: a display name is not a search key.
	//
	// The click is taken on the tooltip layer, not the bar: in band mode layerchart lays a
	// full-width transparent rect over each row, so `onBarClick` never receives a click. The
	// whole row is also the easier target.
	$: chartData = data.map((d) => ({ ...d, address: d.sender, sender: d.senderName || d.sender }));

	$: axisMax = niceAxisMax(Math.max(...chartData.map((d) => d.count)));

	const chartConfig = {
		count: {
			label: $t('app.components.charts.emails'),
		},
	} satisfies ChartConfig;
</script>

<p class="text-muted-foreground mb-2 text-xs">{$t('app.dashboard_page.top_senders_hint')}</p>
<Chart.Container
	config={chartConfig}
	class="min-h-[300px] w-full [&_.lc-tooltip-rect]:cursor-pointer"
>
	<BarChart
		data={chartData}
		x="count"
		y="sender"
		orientation="horizontal"
		xDomain={[0, axisMax]}
		axis={'x'}
		legend={false}
		series={[
			{
				key: 'count',
				...chartConfig.count,
			},
		]}
		cRange={[
			'var(--color-chart-1)',
			'var(--color-chart-2)',
			'var(--color-chart-3)',
			'var(--color-chart-4)',
			'var(--color-chart-5)',
		]}
		labels={{}}
		onTooltipClick={(_e, { data }) => goto(searchUrl({ from: data.address }))}
		props={{
			// Wider than the history chart's y axis: these labels are counts laid out along the
			// bottom, so they compete for width rather than height and "150,000" is a long tick.
			xAxis: { tickSpacing: 110 },
		}}
	>
		{#snippet tooltip()}
			<Chart.Tooltip />
		{/snippet}
	</BarChart>
</Chart.Container>
