declare module '*.ttf' {
	const data: Uint8Array;
	export default data;
}

/** `import code from 'worker:./file.ts'` – bundled separately by esbuild, imported as source text. */
declare module 'worker:*' {
	const code: string;
	export default code;
}
