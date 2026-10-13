import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	resolve: {
		// the apps' aliases, so a module tested here resolves as it does in either app
		alias: { $terrain: here('./terrain'), $zoomview: here('./zoomview'), $world: here('./world') }
	},
	test: {
		include: ['{terrain,zoomview,world}/**/*.test.ts'],
		environment: 'node'
	}
});
