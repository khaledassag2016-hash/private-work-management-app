import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertBindingContract,
  assertCandidateParity,
  buildPackage,
  extractSingleActiveVersion,
  loadManifest,
  repositoryRoot,
  validateManifest,
  validateSourceContracts,
} from './deploy.mjs';

function remoteVersion(manifest) {
  return {
    resources: {
      script_runtime: {
        compatibility_date: manifest.worker.compatibilityDate,
        compatibility_flags: manifest.worker.compatibilityFlags,
      },
      bindings: manifest.requiredBindings.map((binding) => ({
        name: binding.name,
        type: binding.type,
        ...(binding.id ? { id: binding.id } : {}),
        ...(binding.type === 'plain_text' ? { text: manifest.fixedPlainText[binding.name] || `synthetic-${binding.name}` } : {}),
      })),
    },
  };
}

test('manifest locks the production identity and fail-closed values', async () => {
  const manifest = validateManifest(await loadManifest());
  assert.equal(manifest.worker.name, 'assagwork-app');
  assert.equal(manifest.d1.databaseId, '15c9e94c-54e7-487a-9996-0d712b11dccf');
  assert.equal(manifest.fixedPlainText.TEST_CONTROLS, 'disabled');
  for (const [pathName, value] of [
    ['worker', 'wrong-worker'],
    ['d1', '00000000-0000-4000-8000-000000000000'],
    ['test-controls', 'enabled'],
  ]) {
    const changed = structuredClone(manifest);
    if (pathName === 'worker') changed.worker.name = value;
    if (pathName === 'd1') changed.d1.databaseId = value;
    if (pathName === 'test-controls') changed.fixedPlainText.TEST_CONTROLS = value;
    assert.throws(() => validateManifest(changed), /DEPLOYMENT_GUARD_FAILED/);
  }
});

test('source contract provides runtime Firebase config before app bootstrap', async () => {
  const manifest = validateManifest(await loadManifest());
  await validateSourceContracts(manifest);
});

test('asset package preserves every governed /assets path', async () => {
  const manifest = validateManifest(await loadManifest());
  const { outputDirectory, configPath } = await buildPackage(manifest);
  assert.equal(await readFile(path.join(outputDirectory, 'index.html'), 'utf8').then((value) => value.includes('/app-config.js')), true);
  for (const asset of manifest.assets.required) {
    const deployed = path.join(outputDirectory, asset.url.replace(/^\//, ''));
    const source = path.join(repositoryRoot, manifest.source.assets, asset.source);
    assert.deepEqual(await readFile(deployed), await readFile(source));
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.name, manifest.worker.name);
  assert.equal(config.d1_databases[0].database_id, manifest.d1.databaseId);
  assert.equal(config.assets.directory, './public');
  assert.equal(config.assets.binding, 'ASSETS');
  assert.equal(config.observability.enabled, true);
});

test('remote binding parity rejects missing, changed, or stale production config', async () => {
  const manifest = validateManifest(await loadManifest());
  const active = remoteVersion(manifest);
  const candidate = structuredClone(active);
  assert.doesNotThrow(() => assertCandidateParity(active, candidate, manifest));
  const missing = structuredClone(candidate);
  missing.resources.bindings = missing.resources.bindings.filter((binding) => binding.name !== 'ASSETS');
  assert.throws(() => assertBindingContract(missing, manifest), /binding allowlist differs/);
  const wrongD1 = structuredClone(candidate);
  wrongD1.resources.bindings.find((binding) => binding.name === 'DB').id = '00000000-0000-4000-8000-000000000000';
  assert.throws(() => assertBindingContract(wrongD1, manifest), /DB resource ID mismatch/);
  const enabledControls = structuredClone(candidate);
  enabledControls.resources.bindings.find((binding) => binding.name === 'TEST_CONTROLS').text = 'enabled';
  assert.throws(() => assertBindingContract(enabledControls, manifest), /TEST_CONTROLS value mismatch/);
  const drift = structuredClone(candidate);
  drift.resources.bindings.find((binding) => binding.name === 'RUN_MARKER').text = 'different';
  assert.throws(() => assertCandidateParity(active, drift, manifest), /RUN_MARKER value drift/);
});

test('staging requires one and only one production version at 100 percent', () => {
  const versionId = '3020f65e-4ffd-47e3-b373-1c053ffe1297';
  assert.equal(extractSingleActiveVersion({ versions: [{ version_id: versionId, percentage: 100 }] }), versionId);
  assert.throws(() => extractSingleActiveVersion({ versions: [{ version_id: versionId, percentage: 90 }] }), /100% traffic/);
  assert.throws(() => extractSingleActiveVersion({ versions: [] }), /exactly one active version/);
});

test('the sole production workflow gates promotion and cannot write from a PR', async () => {
  const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'production-deployment.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /PRODUCTION_APPROVAL_GUARD/);
  assert.match(workflow, /deploy\.mjs stage/);
  assert.match(workflow, /deploy\.mjs promote/);
  assert.doesNotMatch(workflow, /d1 (?:execute|migrations apply)/);
});
