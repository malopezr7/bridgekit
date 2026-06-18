// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'BridgeKit',
			description:
				'Typed, bidirectional communication between React Native and native code: contracts, providers, reactive streams and observable state.',
			tagline: 'One contract. Both sides. No bridge boilerplate.',
			customCss: ['./src/styles/global.css'],
			components: {
				Hero: './src/components/Hero.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
				SocialIcons: './src/components/SocialIcons.astro',
			},
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/malopezr7/bridgekit' },
			],
			head: [
				{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
				{
					tag: 'link',
					attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
				},
				{
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href: 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap',
					},
				},
			],
			lastUpdated: true,
			pagination: true,
			tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
			expressiveCode: {
				themes: ['github-dark-default', 'github-light'],
				styleOverrides: {
					borderRadius: '0.5rem',
					borderColor: 'var(--sl-color-gray-5)',
					codeFontSize: '0.85rem',
				},
			},
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'What is BridgeKit', slug: 'start/introduction' },
						{ label: 'Core concepts', slug: 'start/concepts' },
						{ label: 'Quick start', slug: 'start/quickstart' },
						{ label: 'Installation', slug: 'start/installation' },
					],
				},
				{
					label: 'Contracts',
					items: [
						{ label: 'Defining a contract', slug: 'contracts/defining' },
						{ label: 'The schema DSL', slug: 'contracts/schema' },
						{ label: 'Methods, streams & state', slug: 'contracts/methods-streams-state' },
					],
				},
				{
					label: 'Directionality',
					items: [
						{ label: 'JS → Native', slug: 'directionality/js-to-native' },
						{ label: 'Native → JS (reverse)', slug: 'directionality/native-to-js' },
						{ label: 'Local-first resolution', slug: 'directionality/local-first' },
						{ label: 'Scopes, bindings & epochs', slug: 'directionality/scopes' },
					],
				},
				{
					label: 'Code generation',
					items: [
						{ label: 'The BridgeKit CLI', slug: 'codegen/cli' },
						{ label: 'Anatomy of generated Kotlin', slug: 'codegen/generated-kotlin' },
						{ label: 'Anatomy of generated Swift', slug: 'codegen/generated-swift' },
						{ label: 'Drift & cross-repo delivery', slug: 'codegen/drift' },
					],
				},
				{
					label: 'Runtime',
					items: [
						{ label: 'Architecture & epochs', slug: 'runtime/architecture' },
						{ label: 'Wire protocol & errors', slug: 'runtime/wire-protocol' },
						{ label: 'Threading model', slug: 'runtime/threading' },
					],
				},
				{
					label: 'Using BridgeKit',
					items: [
						{ label: 'React hooks', slug: 'usage/react-hooks' },
						{ label: 'Marker contract hooks', slug: 'usage/contract-hook' },
						{ label: 'Kotlin: provide & consume', slug: 'usage/kotlin' },
						{ label: 'Swift: provide & consume', slug: 'usage/swift' },
						{ label: 'Auto-discovery', slug: 'usage/discovery' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'End-to-end demo walkthrough', slug: 'guides/demo-walkthrough' },
						{ label: 'Migrating a feature', slug: 'guides/migration' },
						{ label: 'Testing', slug: 'guides/testing' },
						{ label: 'Observability & debugging', slug: 'guides/observability' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'API cheat sheet', slug: 'reference/cheatsheet' },
						{ label: 'Limitations & non-goals', slug: 'reference/limitations' },
						{ label: 'Roadmap', slug: 'reference/roadmap' },
					],
				},
			],
		}),
	],
	vite: { plugins: [tailwindcss()] },
});
