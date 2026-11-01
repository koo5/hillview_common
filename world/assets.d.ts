// vite's `?url` import (the decode worker's laz-perf wasm): both apps build with vite, which resolves it to the
// asset's URL; declared here because this repo depends on no vite types of its own
declare module '*?url' {
	const url: string;
	export default url;
}
