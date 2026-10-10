<script lang="ts">
	import '../app.css';
	import { authStore } from '$lib/stores/auth.store';
	import { theme } from '$lib/stores/theme.store';
	import { browser } from '$app/environment';
	import Footer from '$lib/components/custom/Footer.svelte';
	import { getAlert } from '$lib/components/custom/alert/alert-state.svelte';
	import Alerts from '$lib/components/custom/alert/Alerts.svelte';

	let { data, children } = $props();

	$effect(() => {
		authStore.syncWithServer(data.user, data.accessToken);
	});

	$effect(() => {
		if (browser) {
			let finalTheme = $theme;

			if (finalTheme === 'system') {
				finalTheme = data.systemSettings?.theme || 'system';
			}

			// Cache the instance default for the pre-paint script in app.html, which runs
			// before any data is loaded and would otherwise not know it.
			try {
				localStorage.setItem('theme-default', data.systemSettings?.theme || 'system');
			} catch {
				// Storage blocked (private mode, policy): the script falls back to the OS setting.
			}

			const isDark =
				finalTheme === 'dark' ||
				(finalTheme === 'system' &&
					window.matchMedia('(prefers-color-scheme: dark)').matches);
			document.documentElement.classList.toggle('dark', isDark);
		}
	});
</script>

<Alerts {...getAlert()}></Alerts>
<div class="flex min-h-screen flex-col">
	<main class="flex-1">
		{@render children()}
	</main>
	<Footer currentVersion={data.currentVersion} newVersionInfo={data.newVersionInfo} />
</div>
