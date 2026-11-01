/**
 * City models: IPR Praha's 3D buildings, as earth prepares them (its citymodels.py) and serves them in a channel's
 * `models` release (/t/{release}/models/manifest.json, meshes beside it; a workbench passes them on as
 * /terrain/citymodels). All acquisition, I3S decode and datum conversion is done ahead, in earth; here a release's
 * manifest is read, checked, and its meshes nearest the camera are drawn, each checked against its sha256. From the
 * Codex session's sketch (2026-10-15); moved here from the workbench for the public scene (ea07).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Frame, type Vec3 } from './geodesy';
import { localAxes } from './compass';
import type { View } from './terrainTiles';
import { WorldRequests, RequestFailure, responseOrThrow } from './worldRequests';

export type CityAsset = { id: string; url: string; sha256: string; bytes: number; triangles: number;
	anchor: Vec3; radius: number; node: string };
export type CityManifest = { schema: number; revision: string; generator: string; output_datum: string;
	areas: { sha256: string; lat: number; lon: number; radius: number }[]; assets: CityAsset[];
	credit: { title: string; attribution: string; source_url: string; license: string; license_url: string; changes: string } };
// What one view draws, nearest first (the operator, 2026-10-16: the sketch's 20 meshes / 500k
// triangles stopped Prague's buildings ~1 km out). A mesh is 108 bytes a triangle (three vertices
// of position, normal, colour), so 1.5 M triangles are ~162 MB; RESIDENT keeps a few more loaded
// than drawn, so turning back does not download them again.
export const MAX_ASSETS = 60, MAX_TRIANGLES = 1_500_000, MAX_BYTES = 192 * 1024 * 1024, REACH_M = 3000;
const RESIDENT = 72;
// a release is up to 4096 meshes (earth's MAX_RELEASE_ASSETS), ~250 bytes of manifest each
const MAX_RELEASE_ASSETS = 4096, MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

async function boundedBody(response: Response, limit: number): Promise<ArrayBuffer> {
	if (!response.body) throw new RequestFailure('Empty city-model response', false);
	const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read(); if (done) break;
			size += value.byteLength;
			if (size > limit) { await reader.cancel(); throw new RequestFailure('City-model response exceeds its size budget', false); }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const result = new Uint8Array(size); let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result.buffer;
}

export function validateManifest(value: unknown, manifestUrl: string): CityManifest {
	const m = value as CityManifest;
	if (!m || m.schema !== 2 || m.output_datum !== 'WGS84 ellipsoidal' || !Array.isArray(m.assets) || m.assets.length > MAX_RELEASE_ASSETS ||
		!m.credit || !['title', 'attribution', 'changes'].every(k => typeof m.credit[k as keyof typeof m.credit] === 'string') ||
		typeof m.revision !== 'string' || !Array.isArray(m.areas) || !m.areas.length ||
		!m.areas.every(a => [a.lat, a.lon, a.radius].every(Number.isFinite))) {
		throw new RequestFailure('Unsupported city-model manifest', false);
	}
	for (const link of [m.credit.source_url, m.credit.license_url]) if (new URL(link).protocol !== 'https:') {
		throw new RequestFailure('City-model credit links must use HTTPS', false);
	}
	const ids = new Set<string>();
	for (const a of m.assets) {
		if (typeof a.id !== 'string' || ids.has(a.id) || !/^[0-9a-f]{64}$/.test(a.sha256) ||
			!Array.isArray(a.anchor) || a.anchor.length !== 3 || !a.anchor.every(Number.isFinite) ||
			Math.abs(a.anchor[0]) > 90 || Math.abs(a.anchor[1]) > 180 || Math.abs(a.anchor[2]) > 20_000 ||
			!Number.isFinite(a.radius) || a.radius <= 0 || a.radius > 20_000 ||
			!Number.isInteger(a.triangles) || a.triangles <= 0 || a.triangles > 30_000 ||
			!Number.isInteger(a.bytes) || a.bytes <= 28 || a.bytes > 4 * 1024 * 1024) {
			throw new RequestFailure('Invalid or oversized city-model asset', false);
		}
		const url = new URL(a.url, manifestUrl);
		if (url.origin !== new URL(manifestUrl).origin || !url.pathname.endsWith(`/${a.sha256}.glb`)) {
			throw new RequestFailure('City-model assets must be content-addressed on the manifest origin', false);
		}
		ids.add(a.id);
	}
	return m;
}

export function selectCityAssets(assets: CityAsset[], frame: Frame, camera: Vec3, view: View) {
	const candidates = assets.map(asset => {
		const p = frame.fromGeodetic(...asset.anchor);
		const d = p.map((n, i) => n - camera[i]);
		const distance = Math.hypot(...d);
		const ahead = d.reduce((sum, n, i) => sum + n * view.dir[i], 0);
		return { asset, distance, ahead };
	}).filter(c => c.distance <= REACH_M + c.asset.radius && c.ahead >= -c.asset.radius)
		.sort((a, b) => a.distance - b.distance || a.asset.id.localeCompare(b.asset.id));
	const desired: CityAsset[] = []; let triangles = 0, bytes = 0;
	for (const { asset } of candidates) {
		if (desired.length >= MAX_ASSETS || triangles + asset.triangles > MAX_TRIANGLES || bytes + asset.bytes > MAX_BYTES) continue;
		desired.push(asset); triangles += asset.triangles; bytes += asset.bytes;
	}
	return { desired, capped: candidates.length - desired.length };
}

function dispose(group: THREE.Object3D) {
	group.removeFromParent();
	group.traverse(o => {
		const mesh = o as THREE.Mesh;
		mesh.geometry?.dispose();
		for (const m of mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []) m.dispose();
	});
}

/** Only the simple, self-contained mesh format emitted by the preparer is admitted. */
export function validateCityGlb(bytes: ArrayBuffer, asset: CityAsset) {
	const v = new DataView(bytes);
	if (bytes.byteLength !== asset.bytes || bytes.byteLength < 28 || v.getUint32(0, true) !== 0x46546c67 ||
		v.getUint32(4, true) !== 2 || v.getUint32(8, true) !== bytes.byteLength || v.getUint32(16, true) !== 0x4e4f534a) {
		throw new RequestFailure('Invalid city-model GLB', false);
	}
	const n = v.getUint32(12, true);
	if (n > 32_768 || 28 + n > bytes.byteLength) throw new RequestFailure('Invalid city-model GLB JSON length', false);
	const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, n)));
	if (doc.asset?.generator !== 'ipr-i3s-glb-v1' || doc.images?.length || doc.extensionsRequired?.length ||
		doc.buffers?.length !== 1 || doc.buffers[0].uri || doc.meshes?.length !== 1 || doc.nodes?.length !== 1 ||
		doc.accessors?.length !== 3 || doc.accessors.some((a: { count: number; type: string; componentType: number }) =>
			a.count !== asset.triangles * 3 || a.type !== 'VEC3' || a.componentType !== 5126)) {
		throw new RequestFailure('Unsupported city-model GLB layout', false);
	}
}

export class CityModelTiles {
	readonly group = new THREE.Group();
	private manifest?: CityManifest;
	private discovery: string;
	private downloads: string;
	private disposed = false;
	private camera?: Vec3;
	private view?: View;
	private desired: CityAsset[] = [];
	private capped = 0;
	private tick = 0;
	private resident = new Map<string, { group: THREE.Group; bytes: number; used: number }>();
	constructor(private o: { manifestUrl: string; frame: Frame; requests: WorldRequests; onChange: () => void }) {
		this.discovery = o.requests.scope('city-model release'); this.downloads = o.requests.scope('city-model assets');
		this.group.name = 'IPR city models';
		this.group.add(new THREE.AmbientLight(0xffffff, 1.5));
		const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(100, -100, 200);
		this.group.add(sun, sun.target);
	}
	get stats() {
		const jobs = this.o.requests.snapshot().filter(j => j.wanted && [this.discovery, this.downloads].includes(j.scope));
		return { drawn: this.desired.filter(a => this.resident.has(a.id)).length, capped: this.capped,
			loading: jobs.filter(j => ['queued', 'loading', 'retrying'].includes(j.state)).length,
			errors: jobs.filter(j => j.error).map(j => `${j.label}: ${j.error}`) };
	}
	get credit() { return this.manifest?.credit; }
	get settled() { return this.stats.loading === 0; }
	update(camera: Vec3, view: View) {
		if (this.disposed) return;
		this.camera = camera; this.view = view;
		const url = this.o.manifestUrl;
		this.o.requests.reconcile(this.discovery, [{ id: url, url, label: 'City-model release', kind: 'models',
			cacheable: true, observeServer: false,
			run: async signal => {
				const r = await responseOrThrow(url, signal);
				const text = new TextDecoder().decode(await boundedBody(r, MAX_MANIFEST_BYTES));
				const manifest = validateManifest(JSON.parse(text), url); signal.throwIfAborted();
				if (this.disposed) return;
				this.manifest = manifest; this.compose(); this.o.onChange();
			}, onState: () => { if (!this.disposed) this.o.onChange(); } }]);
		this.compose();
	}
	private compose() {
		if (!this.manifest || !this.camera || !this.view || this.disposed) return;
		this.tick++;
		const selected = selectCityAssets(this.manifest.assets, this.o.frame, this.camera, this.view);
		this.desired = selected.desired; this.capped = selected.capped;
		const ids = new Set(this.desired.map(a => a.id));
		for (const [id, r] of this.resident) {
			r.group.visible = ids.has(id);
			if (ids.has(id)) r.used = this.tick;
		}
		this.evict();
		this.o.requests.reconcile(this.downloads, this.desired.map(asset => {
			const url = new URL(asset.url, this.o.manifestUrl).href;
			return { id: asset.id, url, label: `IPR building mesh ${asset.node}`, kind: 'models' as const,
				cacheable: true, observeServer: false,
				run: async (signal: AbortSignal) => {
					const response = await responseOrThrow(url, signal);
					const bytes = await boundedBody(response, asset.bytes); signal.throwIfAborted();
					validateCityGlb(bytes, asset);
					const hash = await crypto.subtle.digest('SHA-256', bytes);
					if ([...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('') !== asset.sha256) {
						throw new RequestFailure('City-model asset checksum mismatch', false);
					}
					const gltf = await new GLTFLoader().parseAsync(bytes, '');
					if (signal.aborted || this.disposed) { dispose(gltf.scene); signal.throwIfAborted(); return; }
					const position = this.o.frame.fromGeodetic(...asset.anchor);
					const axes = localAxes(this.o.frame, position);
					const group = new THREE.Group();
					group.position.set(...position);
					group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
						new THREE.Vector3(...axes.e), new THREE.Vector3(...axes.u), new THREE.Vector3(...axes.n).negate()));
					group.add(gltf.scene); group.userData.cityModel = asset;
					group.visible = this.desired.some(a => a.id === asset.id);
					this.resident.set(asset.id, { group, bytes: asset.bytes, used: this.tick });
					this.group.add(group); this.evict(); this.o.onChange();
				}, onState: () => { if (!this.disposed) this.o.onChange(); } };
		}));
	}
	private evict() {
		let bytes = [...this.resident.values()].reduce((n, r) => n + r.bytes, 0);
		const wanted = new Set(this.desired.map(a => a.id));
		for (const [id, r] of [...this.resident].sort((a, b) => a[1].used - b[1].used)) {
			if (this.resident.size <= RESIDENT && bytes <= MAX_BYTES) break;
			if (wanted.has(id)) continue;
			dispose(r.group); this.resident.delete(id); bytes -= r.bytes;
			this.o.requests.forget(this.downloads, id);
		}
	}
	dispose() {
		this.disposed = true; this.o.requests.release(this.discovery); this.o.requests.release(this.downloads);
		for (const r of this.resident.values()) dispose(r.group);
		this.resident.clear(); this.group.removeFromParent();
	}
}
