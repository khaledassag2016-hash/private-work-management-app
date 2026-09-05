import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
export const manifestPath = path.join(scriptDirectory, 'production-manifest.json');
const distributionRoot = path.join(repositoryRoot, '.deployment-dist');
const generatedConfigPath = path.join(distributionRoot, 'wrangler.jsonc');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invariant(condition, message) {
  if (!condition) throw new Error(`DEPLOYMENT_GUARD_FAILED: ${message}`);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function resolveInside(base, relativePath) {
  invariant(typeof relativePath === 'string' && relativePath.length > 0, 'path is required');
  invariant(!path.isAbsolute(relativePath), `absolute path is forbidden: ${relativePath}`);
  const resolved = path.resolve(base, relativePath);
  const prefix = `${path.resolve(base)}${path.sep}`;
  invariant(resolved.startsWith(prefix), `path escapes its root: ${relativePath}`);
  return resolved;
}

export async function loadManifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

export function validateManifest(manifest) {
  invariant(object(manifest), 'manifest must be an object');
  invariant(manifest.schemaVersion === 1, 'unsupported manifest schema');
  invariant(/^4\.118\.0$/.test(manifest.wranglerVersion), 'Wrangler must remain pinned to 4.118.0');
  invariant(/^[0-9a-f]{32}$/i.test(manifest.accountId), 'invalid Cloudflare account ID');
  invariant(manifest.worker?.name === 'assagwork-app', 'production Worker must be assagwork-app');
  invariant(manifest.worker?.customDomain === 'https://app.assagwork.com', 'unexpected production domain');
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(manifest.worker?.compatibilityDate || ''), 'invalid compatibility date');
  invariant(Array.isArray(manifest.worker?.compatibilityFlags), 'compatibility flags must be an array');
  invariant(manifest.d1?.binding === 'DB', 'production D1 binding must be DB');
  invariant(manifest.d1?.databaseId === '15c9e94c-54e7-487a-9996-0d712b11dccf', 'unexpected production D1 ID');
  invariant(manifest.firebase?.projectId === 'assagwork-prod-be239c6980', 'unexpected Firebase project');
  invariant(manifest.firebase?.runtimeConfigPath === '/app-config.js', 'runtime config path must be /app-config.js');
  invariant(manifest.fixedPlainText?.TEST_CONTROLS === 'disabled', 'TEST_CONTROLS must be disabled');
  invariant(manifest.fixedPlainText?.FIREBASE_PROJECT_ID === manifest.firebase.projectId, 'Firebase project lock mismatch');
  invariant(Array.isArray(manifest.requiredBindings) && manifest.requiredBindings.length > 0, 'required bindings are missing');
  const bindingNames = manifest.requiredBindings.map((binding) => binding.name);
  invariant(new Set(bindingNames).size === bindingNames.length, 'duplicate binding names');
  invariant(JSON.stringify([...bindingNames].sort()) === JSON.stringify([
    'ASSETS',
    'DB',
    'FIREBASE_API_KEY',
    'FIREBASE_APP_ID',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_PROJECT_ID',
    'RUN_MARKER',
    'TEST_CONTROLS',
  ].sort()), 'binding allowlist changed');
  const d1 = manifest.requiredBindings.find((binding) => binding.name === 'DB');
  invariant(d1?.type === 'd1' && d1.id === manifest.d1.databaseId, 'D1 binding identity mismatch');
  invariant(manifest.requiredBindings.find((binding) => binding.name === 'ASSETS')?.type === 'assets', 'ASSETS binding is required');
  for (const name of bindingNames.filter((name) => !['ASSETS', 'DB'].includes(name))) {
    invariant(manifest.requiredBindings.find((binding) => binding.name === name)?.type === 'plain_text', `${name} must be plain_text`);
  }
  invariant(manifest.source?.worker === 'tools/s3_cpu_gate/src/worker/src/index.js', 'canonical Worker path changed');
  invariant(manifest.source?.workerMirror === 'tools/s3_cpu_gate/worker/src/index.js', 'Worker mirror path changed');
  invariant(manifest.source?.assets === 'tools/s3_cpu_gate/src/worker/assets', 'canonical asset path changed');
  invariant(manifest.source?.assetsMirror === 'tools/s3_cpu_gate/worker/assets', 'asset mirror path changed');
  invariant(manifest.assets?.outputDirectory === '.deployment-dist/public', 'asset output path changed');
  invariant(manifest.assets?.binding === 'ASSETS', 'asset binding changed');
  invariant(manifest.assets?.runWorkerFirst === false, 'run_worker_first must remain false');
  invariant(Array.isArray(manifest.assets?.required) && manifest.assets.required.length > 0, 'required asset paths are missing');
  const assetUrls = manifest.assets.required.map((asset) => asset.url);
  invariant(new Set(assetUrls).size === assetUrls.length, 'duplicate asset URLs');
  for (const asset of manifest.assets.required) {
    invariant(/^\/assets\//.test(asset.url), `asset URL must be nested under /assets/: ${asset.url}`);
    resolveInside(resolveInside(repositoryRoot, manifest.source.assets), asset.source);
  }
  invariant(manifest.observability?.enabled === true, 'observability must remain enabled');
  invariant(manifest.logpush === false, 'logpush must remain disabled');
  invariant(Array.isArray(manifest.tailConsumers) && manifest.tailConsumers.length === 0, 'tail consumers must remain empty');
  const serialized = JSON.stringify(manifest);
  invariant(!/api[_-]?token|private[_-]?key|client[_-]?secret/i.test(serialized), 'manifest must not contain credentials');
  return manifest;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function assertExactFile(left, right, label) {
  invariant(await sha256(left) === await sha256(right), `${label} mirrors differ`);
}

async function assertMirrorParity(manifest) {
  const worker = resolveInside(repositoryRoot, manifest.source.worker);
  const workerMirror = resolveInside(repositoryRoot, manifest.source.workerMirror);
  await assertExactFile(worker, workerMirror, 'Worker');
  const assets = resolveInside(repositoryRoot, manifest.source.assets);
  const assetsMirror = resolveInside(repositoryRoot, manifest.source.assetsMirror);
  const canonicalFiles = await listFiles(assets);
  const mirrorFiles = await listFiles(assetsMirror);
  invariant(JSON.stringify(canonicalFiles) === JSON.stringify(mirrorFiles), 'asset mirror file lists differ');
  for (const relative of canonicalFiles) {
    await assertExactFile(path.join(assets, relative), path.join(assetsMirror, relative), `asset ${relative}`);
  }
}

export function parsePublicConfig(source) {
  const prefix = 'window.__PRIVATE_WORK_APP_CONFIG__ = Object.freeze(';
  const suffix = ');';
  invariant(source.startsWith(prefix) && source.endsWith(suffix), 'invalid /app-config.js envelope');
  return JSON.parse(source.slice(prefix.length, -suffix.length));
}

export async function validateSourceContracts(manifest) {
  await assertMirrorParity(manifest);
  const assetsDirectory = resolveInside(repositoryRoot, manifest.source.assets);
  const index = await readFile(path.join(assetsDirectory, manifest.assets.indexSource), 'utf8');
  const configPosition = index.indexOf('<script src="/app-config.js"></script>');
  const appPosition = index.indexOf('<script type="module" src="/assets/app.js"></script>');
  invariant(configPosition >= 0, 'index.html does not load /app-config.js');
  invariant(appPosition > configPosition, '/app-config.js must load before /assets/app.js');
  const appSource = await readFile(path.join(assetsDirectory, 'app.js'), 'utf8');
  invariant(appSource.includes('window.__PRIVATE_WORK_APP_CONFIG__ || {}'), 'frontend does not read the runtime config');
  invariant(appSource.includes('if (!appConfig.firebaseConfig) return null;'), 'Firebase bootstrap guard is missing');
  invariant(appSource.includes('initializeApp(appConfig.firebaseConfig)'), 'Firebase bootstrap does not use runtime config');
  const workerPath = resolveInside(repositoryRoot, manifest.source.worker);
  const workerSource = await readFile(workerPath, 'utf8');
  const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
  const completeEnv = {
    FIREBASE_API_KEY: 'synthetic-api-key',
    FIREBASE_AUTH_DOMAIN: 'synthetic.example.invalid',
    FIREBASE_PROJECT_ID: manifest.firebase.projectId,
    FIREBASE_APP_ID: 'synthetic-app-id',
  };
  const response = await workerModule.default.fetch(new Request(`${manifest.worker.customDomain}${manifest.firebase.runtimeConfigPath}`), completeEnv);
  invariant(response.status === 200, '/app-config.js must return 200');
  invariant(response.headers.get('content-type')?.startsWith('application/javascript'), '/app-config.js content type is invalid');
  invariant(response.headers.get('cache-control') === 'no-store', '/app-config.js must not be cached');
  const config = parsePublicConfig(await response.text());
  invariant(config.firebaseConfig?.projectId === manifest.firebase.projectId, 'runtime Firebase project mismatch');
  invariant(Object.values(config.firebaseConfig || {}).every((value) => typeof value === 'string' && value.length > 0), 'runtime Firebase config is incomplete');
  const incomplete = await workerModule.default.fetch(new Request(`${manifest.worker.customDomain}${manifest.firebase.runtimeConfigPath}`), { ...completeEnv, FIREBASE_API_KEY: '' });
  const incompleteConfig = parsePublicConfig(await incomplete.text());
  invariant(!Object.hasOwn(incompleteConfig, 'firebaseConfig'), 'partial Firebase config must fail closed');
}

function generatedWranglerConfig(manifest) {
  return {
    name: manifest.worker.name,
    main: `../${manifest.source.worker}`,
    compatibility_date: manifest.worker.compatibilityDate,
    compatibility_flags: manifest.worker.compatibilityFlags,
    assets: {
      directory: './public',
      binding: manifest.assets.binding,
      html_handling: manifest.assets.htmlHandling,
      not_found_handling: manifest.assets.notFoundHandling,
      run_worker_first: manifest.assets.runWorkerFirst,
    },
    d1_databases: [{
      binding: manifest.d1.binding,
      database_name: manifest.d1.databaseName,
      database_id: manifest.d1.databaseId,
    }],
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
    logpush: manifest.logpush,
    tail_consumers: manifest.tailConsumers,
  };
}

export async function buildPackage(manifest) {
  const outputDirectory = resolveInside(repositoryRoot, manifest.assets.outputDirectory);
  await rm(distributionRoot, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const assetsDirectory = resolveInside(repositoryRoot, manifest.source.assets);
  await copyFile(path.join(assetsDirectory, manifest.assets.indexSource), path.join(outputDirectory, 'index.html'));
  for (const asset of manifest.assets.required) {
    const source = resolveInside(assetsDirectory, asset.source);
    const destination = resolveInside(outputDirectory, asset.url.replace(/^\//, ''));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await assertExactFile(source, destination, asset.url);
  }
  await writeFile(generatedConfigPath, `${JSON.stringify(generatedWranglerConfig(manifest), null, 2)}\n`, 'utf8');
  return { outputDirectory, configPath: generatedConfigPath };
}

export async function validateAll() {
  const manifest = validateManifest(await loadManifest());
  await validateSourceContracts(manifest);
  const built = await buildPackage(manifest);
  console.log('DEPLOYMENT_GUARDS: PASS');
  return { manifest, ...built };
}

function runWrangler(manifest, args, { display = false } = {}) {
  const binary = process.env.WRANGLER_BIN || (process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  const output = execFileSync(binary, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: manifest.accountId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (display) process.stdout.write(output);
  return output;
}

function requireCloudAuthorization() {
  invariant(typeof process.env.CLOUDFLARE_API_TOKEN === 'string' && process.env.CLOUDFLARE_API_TOKEN.length > 0, 'CLOUDFLARE_API_TOKEN is required');
}

function assertWranglerVersion(manifest) {
  const output = runWrangler(manifest, ['--version']);
  invariant(new RegExp(`(?:^|\\s)${manifest.wranglerVersion.replaceAll('.', '\\.')}\\b`).test(output), `Wrangler ${manifest.wranglerVersion} is required`);
}

function readJsonCommand(manifest, args) {
  return JSON.parse(runWrangler(manifest, args));
}

export function extractSingleActiveVersion(deployment) {
  invariant(Array.isArray(deployment?.versions), 'Wrangler deployment status has no versions');
  invariant(deployment.versions.length === 1, 'production must have exactly one active version before staging');
  const item = deployment.versions[0];
  invariant(uuidPattern.test(item.version_id || ''), 'active version ID is invalid');
  invariant(Number(item.percentage) === 100, 'active production version must have 100% traffic');
  return item.version_id;
}

function bindingIdentity(binding) {
  return {
    name: binding.name,
    type: binding.type,
    id: binding.type === 'd1' ? (binding.id || binding.database_id || '') : '',
  };
}

function bindingMap(version) {
  invariant(Array.isArray(version?.resources?.bindings), 'version bindings are unavailable');
  return new Map(version.resources.bindings.map((binding) => [binding.name, binding]));
}

export function assertBindingContract(version, manifest) {
  const actual = bindingMap(version);
  const expectedNames = manifest.requiredBindings.map((binding) => binding.name).sort();
  const actualNames = [...actual.keys()].sort();
  invariant(JSON.stringify(actualNames) === JSON.stringify(expectedNames), 'remote binding allowlist differs from the manifest');
  for (const expected of manifest.requiredBindings) {
    const current = actual.get(expected.name);
    invariant(current?.type === expected.type, `${expected.name} binding type mismatch`);
    if (expected.id) invariant(bindingIdentity(current).id === expected.id, `${expected.name} resource ID mismatch`);
  }
  for (const [name, value] of Object.entries(manifest.fixedPlainText)) {
    invariant(actual.get(name)?.text === value, `${name} value mismatch`);
  }
  const runtime = version.resources.script_runtime;
  invariant(runtime?.compatibility_date === manifest.worker.compatibilityDate, 'compatibility date mismatch');
  invariant(JSON.stringify([...(runtime?.compatibility_flags || [])].sort()) === JSON.stringify([...manifest.worker.compatibilityFlags].sort()), 'compatibility flags mismatch');
}

export function assertCandidateParity(activeVersion, candidateVersion, manifest) {
  assertBindingContract(activeVersion, manifest);
  assertBindingContract(candidateVersion, manifest);
  const active = bindingMap(activeVersion);
  const candidate = bindingMap(candidateVersion);
  for (const expected of manifest.requiredBindings) {
    invariant(JSON.stringify(bindingIdentity(active.get(expected.name))) === JSON.stringify(bindingIdentity(candidate.get(expected.name))), `${expected.name} binding identity drift`);
    if (expected.type === 'plain_text') {
      invariant(typeof active.get(expected.name)?.text === 'string', `${expected.name} active value is unavailable`);
      invariant(candidate.get(expected.name)?.text === active.get(expected.name).text, `${expected.name} value drift`);
    }
  }
}

function versionView(manifest, versionId) {
  invariant(uuidPattern.test(versionId), 'invalid version ID');
  return readJsonCommand(manifest, ['versions', 'view', versionId, '--name', manifest.worker.name, '--json']);
}

function deploymentStatus(manifest) {
  return readJsonCommand(manifest, ['deployments', 'status', '--name', manifest.worker.name, '--json']);
}

function assertSplit(deployment, expected) {
  invariant(Array.isArray(deployment?.versions), 'deployment versions are unavailable');
  const actual = new Map(deployment.versions.map((item) => [item.version_id, Number(item.percentage)]));
  invariant(actual.size === expected.size, 'unexpected number of deployed versions');
  for (const [versionId, percentage] of expected) invariant(actual.get(versionId) === percentage, `traffic mismatch for ${versionId}`);
}

function overrideHeaders(manifest, candidateVersion) {
  return candidateVersion ? { 'Cloudflare-Workers-Version-Overrides': `${manifest.worker.name}="${candidateVersion}"` } : {};
}

async function responseSha256(response) {
  return createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
}

export async function httpSmoke(manifest, candidateVersion = '') {
  if (candidateVersion) invariant(uuidPattern.test(candidateVersion), 'invalid candidate version ID');
  const base = manifest.worker.customDomain;
  const headers = overrideHeaders(manifest, candidateVersion);
  const probes = [
    { url: '/', file: path.join(resolveInside(repositoryRoot, manifest.assets.outputDirectory), 'index.html') },
    ...manifest.assets.required.map((asset) => ({
      url: asset.url,
      file: resolveInside(resolveInside(repositoryRoot, manifest.assets.outputDirectory), asset.url.replace(/^\//, '')),
    })),
  ];
  for (const probe of probes) {
    const response = await fetch(new URL(probe.url, base), { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    invariant(response.status === 200, `${probe.url} returned ${response.status}`);
    invariant(await responseSha256(response) === await sha256(probe.file), `${probe.url} content differs from the candidate package`);
  }
  const configResponse = await fetch(new URL(manifest.firebase.runtimeConfigPath, base), { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  invariant(configResponse.status === 200, '/app-config.js did not return 200');
  invariant(configResponse.headers.get('content-type')?.startsWith('application/javascript'), '/app-config.js content type drift');
  invariant(configResponse.headers.get('cache-control') === 'no-store', '/app-config.js cache policy drift');
  const config = parsePublicConfig(await configResponse.text());
  invariant(config.firebaseConfig?.projectId === manifest.firebase.projectId, 'deployed Firebase project mismatch');
  invariant(Object.values(config.firebaseConfig || {}).length === 4 && Object.values(config.firebaseConfig).every((value) => typeof value === 'string' && value.length > 0), 'deployed Firebase config is incomplete');
}

async function browserSmoke(manifest, candidateVersion = '') {
  const smoke = await import('./smoke-login.mjs');
  await smoke.verifyLogin(manifest, candidateVersion);
}

function writeWorkflowOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

function appendSummary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8');
}

async function stage() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    invariant(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'Cloud writes are allowed only from workflow_dispatch');
    invariant(process.env.GITHUB_REF === 'refs/heads/main', 'Cloud writes are allowed only from main');
  }
  requireCloudAuthorization();
  const { manifest, configPath } = await validateAll();
  assertWranglerVersion(manifest);
  const currentDeployment = deploymentStatus(manifest);
  const previousVersion = extractSingleActiveVersion(currentDeployment);
  const activeVersion = versionView(manifest, previousVersion);
  assertBindingContract(activeVersion, manifest);
  runWrangler(manifest, ['versions', 'upload', '--config', configPath, '--keep-vars', '--strict', '--dry-run', '--outdir', path.join(distributionRoot, 'dry-run')], { display: true });
  const revision = (process.env.GITHUB_SHA || 'local').slice(0, 12).toLowerCase();
  const upload = runWrangler(manifest, [
    'versions', 'upload',
    '--config', configPath,
    '--keep-vars',
    '--strict',
    '--preview-alias', `candidate-${revision}`,
    '--tag', `production-${revision}`,
    '--message', `Production candidate ${revision}; zero traffic`,
  ], { display: true });
  const candidateVersion = upload.match(/Worker Version ID:\s*([0-9a-f-]{36})/i)?.[1] || '';
  invariant(uuidPattern.test(candidateVersion), 'Wrangler did not return a candidate version ID');
  const candidate = versionView(manifest, candidateVersion);
  assertCandidateParity(activeVersion, candidate, manifest);
  runWrangler(manifest, [
    'versions', 'deploy',
    `${previousVersion}@100%`,
    `${candidateVersion}@0%`,
    '--config', configPath,
    '--name', manifest.worker.name,
    '--yes',
    '--message', `Stage ${candidateVersion} at zero traffic; rollback ${previousVersion}`,
  ], { display: true });
  assertSplit(deploymentStatus(manifest), new Map([[previousVersion, 100], [candidateVersion, 0]]));
  await httpSmoke(manifest, candidateVersion);
  await browserSmoke(manifest, candidateVersion);
  writeWorkflowOutput('previous_version', previousVersion);
  writeWorkflowOutput('candidate_version', candidateVersion);
  appendSummary([
    '## Production candidate verified at 0%',
    `- Candidate: \`${candidateVersion}\``,
    `- Rollback target: \`${previousVersion}\``,
    '- Bindings and plain-text values: exact parity',
    '- Assets, /app-config.js, and login form: verified with Version Override',
  ]);
  console.log(`CANDIDATE_READY: ${candidateVersion}`);
  console.log(`ROLLBACK_TARGET: ${previousVersion}`);
}

function readOption(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : '';
}

async function promote() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    invariant(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'Cloud writes are allowed only from workflow_dispatch');
    invariant(process.env.GITHUB_REF === 'refs/heads/main', 'Cloud writes are allowed only from main');
  }
  requireCloudAuthorization();
  const previousVersion = readOption('previous');
  const candidateVersion = readOption('candidate');
  invariant(uuidPattern.test(previousVersion), 'invalid rollback version');
  invariant(uuidPattern.test(candidateVersion), 'invalid candidate version');
  invariant(previousVersion !== candidateVersion, 'candidate and rollback versions must differ');
  const { manifest, configPath } = await validateAll();
  assertWranglerVersion(manifest);
  const active = versionView(manifest, previousVersion);
  const candidate = versionView(manifest, candidateVersion);
  assertCandidateParity(active, candidate, manifest);
  assertSplit(deploymentStatus(manifest), new Map([[previousVersion, 100], [candidateVersion, 0]]));
  await httpSmoke(manifest, candidateVersion);
  await browserSmoke(manifest, candidateVersion);
  let activated = false;
  try {
    runWrangler(manifest, [
      'versions', 'deploy',
      `${candidateVersion}@100%`,
      '--config', configPath,
      '--name', manifest.worker.name,
      '--yes',
      '--message', `Promote verified candidate ${candidateVersion}; rollback ${previousVersion}`,
    ], { display: true });
    activated = true;
    assertSplit(deploymentStatus(manifest), new Map([[candidateVersion, 100]]));
    await httpSmoke(manifest);
    await browserSmoke(manifest);
  } catch (error) {
    if (activated) {
      runWrangler(manifest, [
        'versions', 'deploy',
        `${previousVersion}@100%`,
        '--config', configPath,
        '--name', manifest.worker.name,
        '--yes',
        '--message', `Automatic rollback after failed verification of ${candidateVersion}`,
      ], { display: true });
      assertSplit(deploymentStatus(manifest), new Map([[previousVersion, 100]]));
    }
    throw error;
  }
  appendSummary([
    '## Production deployment complete',
    `- Active version: \`${candidateVersion}\` at 100%`,
    `- Saved rollback target: \`${previousVersion}\``,
    '- Post-deployment assets, /app-config.js, and login form: verified',
  ]);
  console.log(`PRODUCTION_ACTIVE: ${candidateVersion}`);
  console.log(`ROLLBACK_TARGET: ${previousVersion}`);
}

async function main() {
  const command = process.argv[2] || 'validate';
  if (command === 'validate') await validateAll();
  else if (command === 'stage') await stage();
  else if (command === 'promote') await promote();
  else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
