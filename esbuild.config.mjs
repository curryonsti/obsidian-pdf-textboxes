import esbuild from 'esbuild';
import process from 'process';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const prod = process.argv[2] === 'production';


/**
 * `import code from 'worker:./file.ts'` bundles that file separately and
 * imports its code as a string, so the worker can be started from a Blob URL.
 */
const inlineWorker = {
	name: 'inline-worker',
	setup(build) {
		build.onResolve({ filter: /^worker:/ }, (args) => ({
			path: path.resolve(args.resolveDir, args.path.slice(7)),
			namespace: 'inline-worker',
		}));
		build.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async (args) => {
			const result = await esbuild.build({
				entryPoints: [args.path],
				bundle: true,
				write: false,
				format: 'iife',
				target: 'es2021',
				minify: prod,
				metafile: true,
				logLevel: 'silent',
			});
			return {
				contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
				loader: 'js',
				watchFiles: Object.keys(result.metafile.inputs),
			};
		});
	},
};

const context = await esbuild.context({
	banner: { js: '/* Bundled by esbuild. Source: pdf-textboxes/src */' },
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: ['obsidian', 'electron', ...builtinModules],
	format: 'cjs',
	target: 'es2021',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'main.js',
	minify: prod,
	loader: { '.ttf': 'binary' }, // DejaVu Sans is embedded in main.js
	plugins: [inlineWorker],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
