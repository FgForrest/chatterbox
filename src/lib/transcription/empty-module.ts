// Aliased in for `onnxruntime-node` and `sharp`, the Node-only
// dependencies of `@huggingface/transformers`' Node build. Browser
// transcription runs Transformers.js exclusively in a browser Web Worker
// (onnxruntime-web), so these native packages must never be resolved by
// the bundler.
//
// The Node build default-imports `sharp` and requires `onnxruntime-node`,
// so the stub must expose a default export. Neither is used in the
// browser runtime.
const stub = {};
export default stub;
