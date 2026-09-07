import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertActiveBindingContract,
  assertBindingContract,
  assertCandidateParity,
  assertCleanGitHead,
  assertRemoteObservabilityParity,
  assertScriptSettingsParity,
  assertSubdomainParity,
  buildPackage,
  buildWranglerInvocation,
  candidateStatePath,
  extractSingleActiveVersion,
  firebaseAdminSecretsFromServiceAccount,
  loadCandidateState,
  loadManifest,
  readRemoteSubdomainSettings,
  repositoryRoot,
  saveCandidateState,
  promoteVerifiedCandidateWithRecovery,
  validateManifest,
  verifyPostPromotionSmokeWithRetry,
  validateSourceContracts,
  verifyStagedCandidateWithRecovery,
  versionUploadSecretsArgs,
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

  const activeBeforeFirebaseAdminBootstrap = structuredClone(active);
  activeBeforeFirebaseAdminBootstrap.resources.bindings = activeBeforeFirebaseAdminBootstrap.resources.bindings.filter(
    (binding) => !['FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL', 'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY'].includes(binding.name),
  );
  assert.throws(() => assertActiveBindingContract(activeBeforeFirebaseAdminBootstrap, manifest), /binding allowlist differs/);
  assert.doesNotThrow(() => assertActiveBindingContract(
    activeBeforeFirebaseAdminBootstrap,
    manifest,
    { allowFirebaseAdminBootstrap: true },
  ));
  assert.doesNotThrow(() => assertCandidateParity(
    activeBeforeFirebaseAdminBootstrap,
    candidate,
    manifest,
    { allowFirebaseAdminBootstrap: true },
  ));

  const partiallyConfiguredFirebaseAdmin = structuredClone(activeBeforeFirebaseAdminBootstrap);
  partiallyConfiguredFirebaseAdmin.resources.bindings.push(
    active.resources.bindings.find((binding) => binding.name === 'FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL'),
  );
  assert.throws(() => assertActiveBindingContract(
    partiallyConfiguredFirebaseAdmin,
    manifest,
    { allowFirebaseAdminBootstrap: true },
  ), /requires both secret bindings to be absent/);

  const unexpectedBootstrapBinding = structuredClone(activeBeforeFirebaseAdminBootstrap);
  unexpectedBootstrapBinding.resources.bindings.push({ name: 'UNEXPECTED_SECRET', type: 'secret_text' });
  assert.throws(() => assertActiveBindingContract(
    unexpectedBootstrapBinding,
    manifest,
    { allowFirebaseAdminBootstrap: true },
  ), /binding allowlist differs/);

  const bootstrapCandidateMissingSecret = structuredClone(candidate);
  bootstrapCandidateMissingSecret.resources.bindings = bootstrapCandidateMissingSecret.resources.bindings.filter(
    (binding) => binding.name !== 'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY',
  );
  assert.throws(() => assertCandidateParity(
    activeBeforeFirebaseAdminBootstrap,
    bootstrapCandidateMissingSecret,
    manifest,
    { allowFirebaseAdminBootstrap: true },
  ), /binding allowlist differs/);

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


test('Firebase Admin bootstrap accepts only the exact Production service-account identity and uploads only governed secrets', async () => {
  const manifest = validateManifest(await loadManifest());
  const privateKey = '-----BEGIN PRIVATE KEY-----\nsynthetic-test-key\n-----END PRIVATE KEY-----\n';
  const serviceAccount = {
    type: 'service_account',
    project_id: manifest.firebase.projectId,
    private_key_id: 'synthetic-key-id',
    private_key: privateKey,
    client_email: `deployment-bootstrap@${manifest.firebase.projectId}.iam.gserviceaccount.com`,
    client_id: 'synthetic-client-id',
  };
  assert.deepEqual(firebaseAdminSecretsFromServiceAccount(serviceAccount, manifest), {
    FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL: serviceAccount.client_email,
    FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
  });
  assert.deepEqual(versionUploadSecretsArgs('/outside-repository/cloudflare-secrets.json'), [
    '--secrets-file',
    '/outside-repository/cloudflare-secrets.json',
  ]);
  assert.deepEqual(versionUploadSecretsArgs(), []);

  const wrongProject = { ...serviceAccount, project_id: 'example-project' };
  assert.throws(() => firebaseAdminSecretsFromServiceAccount(wrongProject, manifest), /project does not match Production/);

  const wrongType = { ...serviceAccount, type: 'authorized_user' };
  assert.throws(() => firebaseAdminSecretsFromServiceAccount(wrongType, manifest), /type must be service_account/);

  const wrongEmail = { ...serviceAccount, client_email: 'deployment-bootstrap@example.invalid' };
  assert.throws(() => firebaseAdminSecretsFromServiceAccount(wrongEmail, manifest), /client email does not match Production project/);

  const wrongKey = { ...serviceAccount, private_key: 'not-a-private-key' };
  assert.throws(() => firebaseAdminSecretsFromServiceAccount(wrongKey, manifest), /private key is invalid/);
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

  const nullTailConsumers = structuredClone(settings);
  nullTailConsumers.tail_consumers = null;
  assert.doesNotThrow(() => assertScriptSettingsParity(nullTailConsumers, manifest));

  const missingTailConsumers = structuredClone(settings);
  delete missingTailConsumers.tail_consumers;
  assert.throws(() => assertScriptSettingsParity(missingTailConsumers, manifest), /remote tail consumers are unavailable/);

  const invalidTailConsumers = structuredClone(settings);
  invalidTailConsumers.tail_consumers = {};
  assert.throws(() => assertScriptSettingsParity(invalidTailConsumers, manifest), /remote tail consumers are unavailable/);

  const nonEmptyTailConsumers = structuredClone(settings);
  nonEmptyTailConsumers.tail_consumers = [{ service: 'unexpected-tail-worker' }];
  assert.throws(() => assertScriptSettingsParity(nonEmptyTailConsumers, manifest), /remote tail consumers differ from the manifest/);

  const manifestExpectingTailConsumer = structuredClone(manifest);
  manifestExpectingTailConsumer.tailConsumers = [{ service: 'expected-tail-worker' }];
  assert.throws(() => assertScriptSettingsParity(nullTailConsumers, manifestExpectingTailConsumer), /remote tail consumers differ from the manifest/);

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
    await saveCandidateState(
      manifest,
      previousVersion,
      candidateVersion,
      sourceSha,
      subdomain,
      { firebaseAdminSecretBootstrap: true },
    );
    await buildPackage(manifest, { subdomainSettings: subdomain });
    const state = await loadCandidateState(manifest);
    assert.equal(state.previousVersion, previousVersion);
    assert.equal(state.candidateVersion, candidateVersion);
    assert.equal(state.sourceSha, sourceSha);
    assert.deepEqual(state.subdomain, subdomain);
    assert.equal(state.firebaseAdminSecretBootstrap, true);
  } finally {
    await rm(path.dirname(candidateStatePath), { recursive: true, force: true });
  }
});

test('Windows Wrangler launcher preserves exact argument boundaries without cmd.exe shell parsing', () => {
  const binary = 'C:\\tools\\npm\\node_modules\\.bin\\wrangler.cmd';
  const shim = 'C:\\tools\\npm\\node_modules\\.bin\\wrangler.ps1';
  const message = 'Production candidate 7acf90e53acd; zero traffic';
  const deploymentSpec = '3020f65e-4ffd-47e3-b373-1c053ffe1297@100%';
  const invocation = buildWranglerInvocation(binary, [
    'versions',
    'upload',
    '--message',
    message,
    deploymentSpec,
  ], {
    platform: 'win32',
    resolveCommand: () => binary,
    fileExists: (value) => value === shim,
    powershellBinary: 'powershell.exe',
  });

  assert.equal(invocation.file, 'powershell.exe');
  assert.deepEqual(invocation.args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', shim,
    'versions',
    'upload',
    '--message',
    message,
    deploymentSpec,
  ]);
  assert.equal(invocation.args.filter((value) => value === message).length, 1);
  assert.equal(invocation.args.filter((value) => value === deploymentSpec).length, 1);
});

test('non-Windows Wrangler launcher remains direct execFile argument passing', () => {
  const args = ['versions', 'upload', '--message', 'Production candidate abc; zero traffic'];
  assert.deepEqual(
    buildWranglerInvocation('/usr/local/bin/wrangler', args, { platform: 'linux' }),
    { file: '/usr/local/bin/wrangler', args },
  );
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

test('post-promotion smoke retries transient propagation failures with bounded backoff', async () => {
  const manifest = validateManifest(await loadManifest());
  let httpAttempts = 0;
  let browserAttempts = 0;
  const sleeps = [];

  await assert.doesNotReject(() => verifyPostPromotionSmokeWithRetry({
    manifest,
    retryDelaysMs: [10, 20, 40],
    sleepFn: async (milliseconds) => { sleeps.push(milliseconds); },
    httpSmokeFn: async () => {
      httpAttempts += 1;
      if (httpAttempts < 3) throw new Error('/ content differs from the candidate package');
    },
    browserSmokeFn: async () => { browserAttempts += 1; },
  }));

  assert.equal(httpAttempts, 3);
  assert.equal(browserAttempts, 1);
  assert.deepEqual(sleeps, [10, 20]);
});

test('post-promotion smoke retry exhaustion remains fail-closed and rolls back', async () => {
  const manifest = validateManifest(await loadManifest());
  const previousVersion = '3020f65e-4ffd-47e3-b373-1c053ffe1297';
  const candidateVersion = 'e3dce50a-c0c9-49ca-b2e6-d5f4404c4f05';
  let deployed = new Map([[previousVersion, 100], [candidateVersion, 0]]);
  const deployCalls = [];
  let smokeAttempts = 0;
  const sleeps = [];

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

  await assert.rejects(() => promoteVerifiedCandidateWithRecovery({
    manifest,
    configPath: '/synthetic/wrangler.jsonc',
    previousVersion,
    candidateVersion,
    deployTrafficFn,
    deploymentStatusFn,
    retryDelaysMs: [0, 0],
    sleepFn: async (milliseconds) => { sleeps.push(milliseconds); },
    httpSmokeFn: async () => {
      smokeAttempts += 1;
      throw new Error('/ content differs from the candidate package');
    },
    browserSmokeFn: async () => {
      throw new Error('browser smoke must not run after HTTP smoke failure');
    },
  }), /content differs from the candidate package/);

  assert.equal(smokeAttempts, 3);
  assert.deepEqual(sleeps, [0, 0]);
  assert.deepEqual(deployCalls, [
    [`${candidateVersion}@100%`],
    [`${previousVersion}@100%`],
  ]);
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
  assert.match(executable, /readOption\('firebase-service-account'\)/);
  assert.match(executable, /versionUploadSecretsArgs\(bootstrapSecrets\?\.secretsFile \|\| ''\)/);
  assert.match(executable, /'versions', 'upload',[\s\S]*\.\.\.secretsArgs/);
  assert.doesNotMatch(executable, /--preview-alias/);
});
