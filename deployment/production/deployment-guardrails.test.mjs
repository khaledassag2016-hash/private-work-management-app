import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertBindingContract,
  assertCandidateParity,
  assertCleanGitHead,
  assertRemoteObservabilityParity,
  assertScriptSettingsParity,
  assertSubdomainParity,
  buildPackage,
  candidateStatePath,
  extractSingleActiveVersion,
  loadCandidateState,
  loadManifest,
  readRemoteSubdomainSettings,
  repositoryRoot,
  saveCandidateState,
  promoteVerifiedCandidateWithRecovery,
  validateManifest,
  validateSourceContracts,
  verifyStagedCandidateWithRecovery,
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
  const firebaseAdminSecrets = ['FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL', 'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY'];
  for (const name of firebaseAdminSecrets) {
    const binding = manifest.requiredBindings.find((item) => item.name === name);
    assert.deepEqual(binding, { name, type: 'secret_text' });
  }
  const leakedSecretValue = structuredClone(manifest);
  leakedSecretValue.requiredBindings.find((item) => item.name === 'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY').value = 'not-a-real-secret';
  assert.throws(() => validateManifest(leakedSecretValue), /manifest entry must contain binding identity only/);
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
  assert.deepEqual(config.secrets, {
    required: ['FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL', 'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY'],
  });
  assert.equal(Object.hasOwn(config.secrets, 'values'), false);
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
  const missingFirebaseAdminSecret = structuredClone(candidate);
  missingFirebaseAdminSecret.resources.bindings = missingFirebaseAdminSecret.resources.bindings.filter((binding) => binding.name !== 'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY');
  assert.throws(() => assertBindingContract(missingFirebaseAdminSecret, manifest), /binding allowlist differs/);
  const wrongFirebaseAdminSecretType = structuredClone(candidate);
  wrongFirebaseAdminSecretType.resources.bindings.find((binding) => binding.name === 'FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL').type = 'plain_text';
  assert.throws(() => assertBindingContract(wrongFirebaseAdminSecretType, manifest), /FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL binding type mismatch/);
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

test('remote script-settings parity covers observability, Logpush, and tail consumers', async () => {
  const manifest = validateManifest(await loadManifest());
  const settings = {
    logpush: manifest.logpush,
    tail_consumers: manifest.tailConsumers,
    observability: {
      enabled: manifest.observability.enabled,
      head_sampling_rate: manifest.observability.headSamplingRate,
      logs: {
        enabled: manifest.observability.logs.enabled,
        head_sampling_rate: manifest.observability.logs.headSamplingRate,
        persist: manifest.observability.logs.persist,
        invocation_logs: manifest.observability.logs.invocationLogs,
      },
      traces: {
        enabled: manifest.observability.traces.enabled,
        head_sampling_rate: manifest.observability.traces.headSamplingRate,
        persist: manifest.observability.traces.persist,
      },
    },
  };
  assert.doesNotThrow(() => assertScriptSettingsParity(settings, manifest));
  const wrong = structuredClone(settings);
  wrong.observability.logs.persist = false;
  assert.throws(() => assertScriptSettingsParity(wrong, manifest), /logs persist setting differs/);
  await assert.doesNotReject(() => assertRemoteObservabilityParity(manifest, {
    tokenProvider: () => 'in-memory-test-token',
    fetchImpl: async () => new Response(JSON.stringify({ success: true, result: settings })),
  }));
  await assert.rejects(() => assertRemoteObservabilityParity(manifest, {
    tokenProvider: () => 'in-memory-test-token',
    fetchImpl: async () => new Response(JSON.stringify({ success: false }), { status: 403 }),
  }), /script-settings read returned HTTP 403/);
});

test('Worker subdomain settings are read-only and explicit in the generated config', async () => {
  const manifest = validateManifest(await loadManifest());
  const locked = { enabled: false, previews_enabled: false };
  const remote = await readRemoteSubdomainSettings(manifest, {
    tokenProvider: () => 'in-memory-test-token',
    fetchImpl: async () => new Response(JSON.stringify({ success: true, result: locked })),
  });
  assert.deepEqual(remote, locked);
  assert.doesNotThrow(() => assertSubdomainParity(remote, locked));
  const changed = { ...locked, previews_enabled: true };
  assert.throws(() => assertSubdomainParity(changed, locked), /preview URL setting differs/);
  const { configPath } = await buildPackage(manifest, { subdomainSettings: remote });
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  await assert.rejects(() => readRemoteSubdomainSettings(manifest, {
    tokenProvider: () => 'in-memory-test-token',
    fetchImpl: async () => new Response(JSON.stringify({ success: false }), { status: 403 }),
  }), /subdomain read returned HTTP 403/);
});

test('candidate state survives package rebuild and locks the exact source SHA', async () => {
  const manifest = validateManifest(await loadManifest());
  const previousVersion = '3020f65e-4ffd-47e3-b373-1c053ffe1297';
  const candidateVersion = 'e3dce50a-c0c9-49ca-b2e6-d5f4404c4f05';
  const sourceSha = 'a'.repeat(40);
  const subdomain = { enabled: false, previews_enabled: false };
  await rm(path.dirname(candidateStatePath), { recursive: true, force: true });
  try {
    await saveCandidateState(manifest, previousVersion, candidateVersion, sourceSha, subdomain);
    await buildPackage(manifest, { subdomainSettings: subdomain });
    const state = await loadCandidateState(manifest);
    assert.equal(state.previousVersion, previousVersion);
    assert.equal(state.candidateVersion, candidateVersion);
    assert.equal(state.sourceSha, sourceSha);
    assert.deepEqual(state.subdomain, subdomain);
  } finally {
    await rm(path.dirname(candidateStatePath), { recursive: true, force: true });
  }
});

test('production staging and promotion require one exact clean Git HEAD', () => {
  const sourceSha = 'b'.repeat(40);
  assert.equal(assertCleanGitHead({
    gitRunner: (args) => args[0] === 'rev-parse' ? `${sourceSha}\n` : '',
  }), sourceSha);
  assert.throws(() => assertCleanGitHead({
    gitRunner: (args) => args[0] === 'rev-parse' ? `${sourceSha}\n` : ' M deployment/production/deploy.mjs\n',
  }), /working tree must be clean/);
});

test('failed Candidate smoke restores the previous version to 100 percent', async () => {
  const manifest = validateManifest(await loadManifest());
  const previousVersion = '3020f65e-4ffd-47e3-b373-1c053ffe1297';
  const candidateVersion = 'e3dce50a-c0c9-49ca-b2e6-d5f4404c4f05';
  let deployed = new Map([[previousVersion, 100]]);
  const deployCalls = [];
  const deployTrafficFn = (versions) => {
    deployCalls.push([...versions]);
    deployed = new Map(versions.map((item) => {
      const [versionId, rawPercentage] = item.split('@');
      return [versionId, Number(rawPercentage.replace('%', ''))];
    }));
  };
  const deploymentStatusFn = () => ({
    versions: [...deployed].map(([version_id, percentage]) => ({ version_id, percentage })),
  });
  await assert.rejects(() => verifyStagedCandidateWithRecovery({
    manifest,
    configPath: '/synthetic/wrangler.jsonc',
    previousVersion,
    candidateVersion,
    sourceSha: 'c'.repeat(40),
    subdomainSettings: { enabled: false, previews_enabled: false },
    deployTrafficFn,
    deploymentStatusFn,
    httpSmokeFn: async () => { throw new Error('synthetic candidate smoke failure'); },
    browserSmokeFn: async () => {},
    saveCandidateStateFn: async () => { throw new Error('state save should not be reached'); },
    clearCandidateStateFn: async () => {},
  }), /synthetic candidate smoke failure/);
  assert.equal(deployCalls.length, 2);
  assert.deepEqual(deployCalls[0], [`${previousVersion}@100%`, `${candidateVersion}@0%`]);
  assert.deepEqual(deployCalls[1], [`${previousVersion}@100%`]);
  assert.deepEqual([...deployed], [[previousVersion, 100]]);
});

test('promotion transport failure after remote activation restores the previous version to 100 percent', async () => {
  const manifest = validateManifest(await loadManifest());
  const previousVersion = '3020f65e-4ffd-47e3-b373-1c053ffe1297';
  const candidateVersion = 'e3dce50a-c0c9-49ca-b2e6-d5f4404c4f05';
  let deployed = new Map([[previousVersion, 100], [candidateVersion, 0]]);
  const deployCalls = [];
  const deployTrafficFn = (versions) => {
    deployCalls.push([...versions]);
    deployed = new Map(versions.map((item) => {
      const [versionId, rawPercentage] = item.split('@');
      return [versionId, Number(rawPercentage.replace('%', ''))];
    }));
    if (versions.length === 1 && versions[0] === `${candidateVersion}@100%`) {
      throw new Error('synthetic transport failure after Cloudflare activated candidate');
    }
  };
  const deploymentStatusFn = () => ({
    versions: [...deployed].map(([version_id, percentage]) => ({ version_id, percentage })),
  });

  await assert.rejects(() => promoteVerifiedCandidateWithRecovery({
    manifest,
    configPath: '/synthetic/wrangler.jsonc',
    previousVersion,
    candidateVersion,
    deployTrafficFn,
    deploymentStatusFn,
    httpSmokeFn: async () => {},
    browserSmokeFn: async () => {},
  }), /synthetic transport failure after Cloudflare activated candidate/);

  assert.deepEqual(deployCalls, [
    [`${candidateVersion}@100%`],
    [`${previousVersion}@100%`],
  ]);
  assert.deepEqual([...deployed], [[previousVersion, 100]]);
});

test('GitHub is validation-only; production execution is local OAuth only', async () => {
  const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'production-deployment.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /node deployment\/production\/deploy\.mjs validate/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|CLOUDFLARE_API_TOKEN|environment: production|deploy\.mjs (?:stage|promote)|versions (?:upload|deploy)/);
  assert.doesNotMatch(workflow, /d1 (?:execute|migrations apply)/);
  const executable = await readFile(path.join(repositoryRoot, 'deployment', 'production', 'deploy.mjs'), 'utf8');
  assert.match(executable, /auth', 'token', '--json/);
  assert.match(executable, /workers\/scripts\/\$\{encodeURIComponent\(manifest\.worker\.name\)\}\/script-settings/);
  assert.match(executable, /workers\/scripts\/\$\{encodeURIComponent\(manifest\.worker\.name\)\}\/subdomain/);
  assert.doesNotMatch(executable, /--preview-alias/);
});
