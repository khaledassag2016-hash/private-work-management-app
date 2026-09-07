import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
export const manifestPath = path.join(scriptDirectory, 'production-manifest.json');
const distributionRoot = path.join(repositoryRoot, '.deployment-dist');
const generatedConfigPath = path.join(distributionRoot, 'wrangler.jsonc');
const candidateStateRoot = path.join(repositoryRoot, '.deployment-state');
export const candidateStatePath = path.join(candidateStateRoot, 'production-candidate-state.json');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const firebaseAdminSecretBindingNames = Object.freeze([
  'FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL',
  'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY',
]);

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
    ...firebaseAdminSecretBindingNames,
    'RUN_MARKER',
    'TEST_CONTROLS',
  ].sort()), 'binding allowlist changed');
  const d1 = manifest.requiredBindings.find((binding) => binding.name === 'DB');
  invariant(d1?.type === 'd1' && d1.id === manifest.d1.databaseId, 'D1 binding identity mismatch');
  invariant(manifest.requiredBindings.find((binding) => binding.name === 'ASSETS')?.type === 'assets', 'ASSETS binding is required');
  const secretBindingNames = new Set(firebaseAdminSecretBindingNames);
  for (const name of bindingNames.filter((name) => !['ASSETS', 'DB'].includes(name))) {
    const expectedType = secretBindingNames.has(name) ? 'secret_text' : 'plain_text';
    invariant(manifest.requiredBindings.find((binding) => binding.name === name)?.type === expectedType, `${name} must be ${expectedType}`);
  }
  for (const name of firebaseAdminSecretBindingNames) {
    const binding = manifest.requiredBindings.find((item) => item.name === name);
    invariant(JSON.stringify(Object.keys(binding || {}).sort()) === JSON.stringify(['name', 'type']), `${name} manifest entry must contain binding identity only`);
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
  const credentialScanManifest = {
    ...manifest,
    requiredBindings: manifest.requiredBindings.map((binding) => secretBindingNames.has(binding.name)
      ? { name: 'REQUIRED_SECRET_BINDING', type: binding.type }
      : binding),
  };
  const serialized = JSON.stringify(credentialScanManifest);
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
  for (const name of firebaseAdminSecretBindingNames) {
    invariant(workerSource.includes(`env.${name}`), `Worker does not consume required secret binding ${name}`);
  }
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

export function assertSubdomainSettings(settings) {
  invariant(object(settings), 'remote Worker subdomain settings are unavailable');
  invariant(typeof settings.enabled === 'boolean', 'remote workers.dev setting is unavailable');
  invariant(typeof settings.previews_enabled === 'boolean', 'remote preview URL setting is unavailable');
  return {
    enabled: settings.enabled,
    previews_enabled: settings.previews_enabled,
  };
}

export function assertSubdomainParity(actual, expected) {
  const current = assertSubdomainSettings(actual);
  const locked = assertSubdomainSettings(expected);
  invariant(current.enabled === locked.enabled, 'workers.dev setting differs from staged state');
  invariant(current.previews_enabled === locked.previews_enabled, 'preview URL setting differs from staged state');
}

function generatedWranglerConfig(manifest, subdomainSettings = null) {
  const config = {
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
    secrets: {
      required: [...firebaseAdminSecretBindingNames],
    },
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
  if (subdomainSettings !== null) {
    const locked = assertSubdomainSettings(subdomainSettings);
    config.workers_dev = locked.enabled;
    config.preview_urls = locked.previews_enabled;
  }
  return config;
}

export async function buildPackage(manifest, { subdomainSettings = null } = {}) {
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
  await writeFile(generatedConfigPath, `${JSON.stringify(generatedWranglerConfig(manifest, subdomainSettings), null, 2)}\n`, 'utf8');
  return { outputDirectory, configPath: generatedConfigPath };
}

export async function validateAll({ subdomainSettings = null } = {}) {
  const manifest = validateManifest(await loadManifest());
  await validateSourceContracts(manifest);
  const built = await buildPackage(manifest, { subdomainSettings });
  console.log('DEPLOYMENT_GUARDS: PASS');
  return { manifest, ...built };
}
function resolveWindowsCommand(binary) {
  if (path.win32.isAbsolute(binary)) return binary;
  const resolved = execFileSync('where.exe', [binary], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  invariant(typeof resolved === 'string' && resolved.length > 0, `Windows command could not be resolved: ${binary}`);
  return resolved;
}

export function buildWranglerInvocation(binary, args, {
  platform = process.platform,
  resolveCommand = resolveWindowsCommand,
  fileExists = existsSync,
  powershellBinary = 'powershell.exe',
} = {}) {
  invariant(typeof binary === 'string' && binary.length > 0, 'Wrangler binary is required');
  invariant(Array.isArray(args) && args.every((value) => typeof value === 'string'), 'Wrangler arguments must be strings');
  if (platform !== 'win32' || !/\.cmd$/i.test(binary)) {
    return { file: binary, args: [...args] };
  }
  const commandPath = resolveCommand(binary);
  invariant(/\.cmd$/i.test(commandPath), 'resolved Windows Wrangler command must be a .cmd shim');
  const powershellShim = commandPath.replace(/\.cmd$/i, '.ps1');
  invariant(fileExists(powershellShim), 'Wrangler PowerShell shim is unavailable');
  return {
    file: powershellBinary,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', powershellShim,
      ...args,
    ],
  };
}

function runWrangler(manifest, args, { display = false } = {}) {
  const binary = process.env.WRANGLER_BIN || (process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  const invocation = buildWranglerInvocation(binary, args);
  const output = execFileSync(invocation.file, invocation.args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: manifest.accountId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (display) process.stdout.write(output);
  return output;
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function assertCleanGitHead({ gitRunner = runGit } = {}) {
  const sourceSha = String(gitRunner(['rev-parse', '--verify', 'HEAD']) || '').trim().toLowerCase();
  invariant(/^[0-9a-f]{40}$/.test(sourceSha), 'exact Git HEAD could not be resolved');
  const status = String(gitRunner(['status', '--porcelain=v1', '--untracked-files=all']) || '').trim();
  invariant(status.length === 0, 'working tree must be clean before production staging or promotion');
  return sourceSha;
}

export function assertLocalOAuthOnly() {
  invariant(process.env.GITHUB_ACTIONS !== 'true', 'production execution is local only; GitHub Actions is validation only');
  invariant(!process.env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN is forbidden; use the existing local Wrangler OAuth session');
}

function readLocalOAuthToken(manifest) {
  const credentials = readJsonCommand(manifest, ['auth', 'token', '--json']);
  const resolved = object(credentials?.result) ? credentials.result : credentials;
  invariant(resolved?.type === 'oauth', 'Wrangler authentication must be the existing local OAuth session');
  const token = resolved?.token;
  invariant(typeof token === 'string' && token.length > 0, 'local Wrangler OAuth did not return an API token');
  return token;
}

export function assertScriptSettingsParity(settings, manifest) {
  invariant(object(settings), 'remote script settings are unavailable');
  invariant(settings.logpush === manifest.logpush, 'remote logpush setting differs from the manifest');
  const tailConsumers = settings.tail_consumers === null ? [] : settings.tail_consumers;
  invariant(Array.isArray(tailConsumers), 'remote tail consumers are unavailable');
  invariant(JSON.stringify(tailConsumers) === JSON.stringify(manifest.tailConsumers), 'remote tail consumers differ from the manifest');
  const observability = settings.observability;
  invariant(object(observability), 'remote observability setting is unavailable');
  invariant(observability.enabled === manifest.observability.enabled, 'remote observability enabled setting differs from the manifest');
  invariant(observability.head_sampling_rate === manifest.observability.headSamplingRate, 'remote observability sampling rate differs from the manifest');
  invariant(object(observability.logs), 'remote observability logs setting is unavailable');
  invariant(observability.logs.enabled === manifest.observability.logs.enabled, 'remote observability logs enabled setting differs from the manifest');
  invariant(observability.logs.head_sampling_rate === manifest.observability.logs.headSamplingRate, 'remote observability logs sampling rate differs from the manifest');
  invariant(observability.logs.persist === manifest.observability.logs.persist, 'remote observability logs persist setting differs from the manifest');
  invariant(observability.logs.invocation_logs === manifest.observability.logs.invocationLogs, 'remote observability invocation logs setting differs from the manifest');
  invariant(object(observability.traces), 'remote observability traces setting is unavailable');
  invariant(observability.traces.enabled === manifest.observability.traces.enabled, 'remote observability traces enabled setting differs from the manifest');
  invariant(observability.traces.head_sampling_rate === manifest.observability.traces.headSamplingRate, 'remote observability traces sampling rate differs from the manifest');
  invariant(observability.traces.persist === manifest.observability.traces.persist, 'remote observability traces persist setting differs from the manifest');
}

export async function assertRemoteObservabilityParity(manifest, { tokenProvider = readLocalOAuthToken, fetchImpl = fetch } = {}) {
  const token = tokenProvider(manifest);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${manifest.accountId}/workers/scripts/${encodeURIComponent(manifest.worker.name)}/script-settings`;
  let response;
  try {
    response = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    invariant(false, 'remote script-settings read failed');
  }
  invariant(response?.ok, `remote script-settings read returned HTTP ${response?.status || 'unknown'}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    invariant(false, 'remote script-settings response is not JSON');
  }
  invariant(payload?.success === true && object(payload.result), 'remote script-settings response is unsuccessful');
  assertScriptSettingsParity(payload.result, manifest);
}

export async function readRemoteSubdomainSettings(manifest, { tokenProvider = readLocalOAuthToken, fetchImpl = fetch } = {}) {
  const token = tokenProvider(manifest);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${manifest.accountId}/workers/scripts/${encodeURIComponent(manifest.worker.name)}/subdomain`;
  let response;
  try {
    response = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    invariant(false, 'remote Worker subdomain read failed');
  }
  invariant(response?.ok, `remote Worker subdomain read returned HTTP ${response?.status || 'unknown'}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    invariant(false, 'remote Worker subdomain response is not JSON');
  }
  invariant(payload?.success === true && object(payload.result), 'remote Worker subdomain response is unsuccessful');
  return assertSubdomainSettings(payload.result);
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

export function assertActiveBindingContract(version, manifest, { allowFirebaseAdminBootstrap = false } = {}) {
  if (!allowFirebaseAdminBootstrap) {
    assertBindingContract(version, manifest);
    return;
  }
  const actual = bindingMap(version);
  const missingSecrets = firebaseAdminSecretBindingNames.filter((name) => !actual.has(name));
  invariant(
    missingSecrets.length === firebaseAdminSecretBindingNames.length,
    'Firebase Admin bootstrap requires both secret bindings to be absent from the active version',
  );
  const baselineManifest = {
    ...manifest,
    requiredBindings: manifest.requiredBindings.filter((binding) => !firebaseAdminSecretBindingNames.includes(binding.name)),
  };
  assertBindingContract(version, baselineManifest);
}

export function assertCandidateParity(activeVersion, candidateVersion, manifest, { allowFirebaseAdminBootstrap = false } = {}) {
  assertActiveBindingContract(activeVersion, manifest, { allowFirebaseAdminBootstrap });
  assertBindingContract(candidateVersion, manifest);
  const active = bindingMap(activeVersion);
  const candidate = bindingMap(candidateVersion);
  for (const expected of manifest.requiredBindings) {
    if (allowFirebaseAdminBootstrap && firebaseAdminSecretBindingNames.includes(expected.name) && !active.has(expected.name)) continue;
    invariant(JSON.stringify(bindingIdentity(active.get(expected.name))) === JSON.stringify(bindingIdentity(candidate.get(expected.name))), `${expected.name} binding identity drift`);
    if (expected.type === 'plain_text') {
      invariant(typeof active.get(expected.name)?.text === 'string', `${expected.name} active value is unavailable`);
      invariant(candidate.get(expected.name)?.text === active.get(expected.name).text, `${expected.name} value drift`);
    }
  }
}

export function firebaseAdminSecretsFromServiceAccount(serviceAccount, manifest) {
  invariant(object(serviceAccount), 'Firebase service-account file must contain one JSON object');
  invariant(serviceAccount.type === 'service_account', 'Firebase credential type must be service_account');
  invariant(serviceAccount.project_id === manifest.firebase.projectId, 'Firebase service-account project does not match Production');
  const clientEmail = typeof serviceAccount.client_email === 'string' ? serviceAccount.client_email.trim() : '';
  invariant(
    clientEmail.endsWith(`@${manifest.firebase.projectId}.iam.gserviceaccount.com`),
    'Firebase service-account client email does not match Production project',
  );
  const privateKey = typeof serviceAccount.private_key === 'string'
    ? serviceAccount.private_key.replace(/\\n/g, '\n').trim()
    : '';
  invariant(
    /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(privateKey),
    'Firebase service-account private key is invalid',
  );
  return {
    FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL: clientEmail,
    FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: `${privateKey}\n`,
  };
}

async function prepareFirebaseAdminBootstrapSecretsFile(serviceAccountPath, manifest) {
  invariant(typeof serviceAccountPath === 'string' && serviceAccountPath.length > 0, 'Firebase service-account path is required');
  invariant(path.isAbsolute(serviceAccountPath), 'Firebase service-account path must be absolute');
  const resolved = path.resolve(serviceAccountPath);
  const repository = path.resolve(repositoryRoot);
  invariant(
    resolved !== repository && !resolved.startsWith(`${repository}${path.sep}`),
    'Firebase service-account file must be outside the repository',
  );
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(await readFile(resolved, 'utf8'));
  } catch {
    invariant(false, 'Firebase service-account file is unavailable or invalid JSON');
  }
  const secrets = firebaseAdminSecretsFromServiceAccount(serviceAccount, manifest);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'assagwork-firebase-admin-'));
  const secretsFile = path.join(temporaryRoot, 'cloudflare-secrets.json');
  await writeFile(secretsFile, `${JSON.stringify(secrets)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    secretsFile,
    cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}

export function versionUploadSecretsArgs(secretsFile = '') {
  return secretsFile ? ['--secrets-file', secretsFile] : [];
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

export const postPromotionSmokeRetryDelaysMs = Object.freeze([1000, 2000, 4000, 8000]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function verifyPostPromotionSmokeWithRetry({
  manifest,
  httpSmokeFn = httpSmoke,
  browserSmokeFn = browserSmoke,
  retryDelaysMs = postPromotionSmokeRetryDelaysMs,
  sleepFn = sleep,
} = {}) {
  invariant(object(manifest), 'post-promotion smoke manifest is required');
  invariant(Array.isArray(retryDelaysMs) && retryDelaysMs.every((value) => Number.isInteger(value) && value >= 0), 'post-promotion smoke retry delays are invalid');
  invariant(typeof sleepFn === 'function', 'post-promotion smoke sleep function is invalid');
  let lastError;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await httpSmokeFn(manifest);
      await browserSmokeFn(manifest);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === retryDelaysMs.length) throw error;
      await sleepFn(retryDelaysMs[attempt]);
    }
  }
  throw lastError;
}

export async function clearCandidateState() {
  await rm(candidateStatePath, { force: true });
}

export async function saveCandidateState(
  manifest,
  previousVersion,
  candidateVersion,
  sourceSha,
  subdomainSettings,
  { firebaseAdminSecretBootstrap = false } = {},
) {
  invariant(/^[0-9a-f]{40}$/.test(sourceSha || ''), 'candidate source SHA is invalid');
  invariant(typeof firebaseAdminSecretBootstrap === 'boolean', 'candidate Firebase Admin bootstrap state is invalid');
  const lockedSubdomain = assertSubdomainSettings(subdomainSettings);
  await mkdir(candidateStateRoot, { recursive: true });
  await writeFile(candidateStatePath, `${JSON.stringify({
    schemaVersion: 3,
    worker: manifest.worker.name,
    previousVersion,
    candidateVersion,
    sourceSha,
    subdomain: lockedSubdomain,
    firebaseAdminSecretBootstrap,
    stagedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

export async function loadCandidateState(manifest) {
  let state;
  try {
    state = JSON.parse(await readFile(candidateStatePath, 'utf8'));
  } catch {
    invariant(false, 'no locally saved candidate state; stage and verify a candidate first');
  }
  invariant(state?.schemaVersion === 3, 'saved candidate state schema is invalid');
  invariant(state.worker === manifest.worker.name, 'saved candidate state targets a different Worker');
  invariant(uuidPattern.test(state.previousVersion || ''), 'saved rollback version is invalid');
  invariant(uuidPattern.test(state.candidateVersion || ''), 'saved candidate version is invalid');
  invariant(state.previousVersion !== state.candidateVersion, 'saved candidate state is invalid');
  invariant(/^[0-9a-f]{40}$/.test(state.sourceSha || ''), 'saved candidate source SHA is invalid');
  invariant(typeof state.firebaseAdminSecretBootstrap === 'boolean', 'saved candidate Firebase Admin bootstrap state is invalid');
  state.subdomain = assertSubdomainSettings(state.subdomain);
  return state;
}

export async function verifyStagedCandidateWithRecovery({
  manifest,
  configPath,
  previousVersion,
  candidateVersion,
  sourceSha,
  subdomainSettings,
  firebaseAdminSecretBootstrap = false,
  deployTrafficFn = (versions, message) => runWrangler(manifest, [
    'versions', 'deploy',
    ...versions,
    '--config', configPath,
    '--name', manifest.worker.name,
    '--yes',
    '--message', message,
  ], { display: true }),
  deploymentStatusFn = () => deploymentStatus(manifest),
  httpSmokeFn = httpSmoke,
  browserSmokeFn = browserSmoke,
  saveCandidateStateFn = saveCandidateState,
  clearCandidateStateFn = clearCandidateState,
} = {}) {
  try {
    deployTrafficFn(
      [`${previousVersion}@100%`, `${candidateVersion}@0%`],
      `Stage ${candidateVersion} at zero traffic; rollback ${previousVersion}`,
    );
    assertSplit(deploymentStatusFn(), new Map([[previousVersion, 100], [candidateVersion, 0]]));
    await httpSmokeFn(manifest, candidateVersion);
    await browserSmokeFn(manifest, candidateVersion);
    await saveCandidateStateFn(
      manifest,
      previousVersion,
      candidateVersion,
      sourceSha,
      subdomainSettings,
      { firebaseAdminSecretBootstrap },
    );
  } catch (error) {
    try {
      deployTrafficFn(
        [`${previousVersion}@100%`],
        `Automatic stage recovery after failed verification of ${candidateVersion}`,
      );
      assertSplit(deploymentStatusFn(), new Map([[previousVersion, 100]]));
      await clearCandidateStateFn();
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'Candidate verification failed and recovery to the previous 100% version also failed',
      );
    }
    throw error;
  }
}

async function stage() {
  assertLocalOAuthOnly();
  const sourceSha = assertCleanGitHead();
  const initialManifest = validateManifest(await loadManifest());
  const serviceAccountPath = readOption('firebase-service-account');
  const firebaseAdminSecretBootstrap = Boolean(serviceAccountPath);
  assertWranglerVersion(initialManifest);
  const oauthToken = readLocalOAuthToken(initialManifest);
  await assertRemoteObservabilityParity(initialManifest, { tokenProvider: () => oauthToken });
  const subdomainSettings = await readRemoteSubdomainSettings(initialManifest, { tokenProvider: () => oauthToken });
  const { manifest, configPath } = await validateAll({ subdomainSettings });
  await clearCandidateState();
  const currentDeployment = deploymentStatus(manifest);
  const previousVersion = extractSingleActiveVersion(currentDeployment);
  const activeVersion = versionView(manifest, previousVersion);
  assertActiveBindingContract(activeVersion, manifest, { allowFirebaseAdminBootstrap: firebaseAdminSecretBootstrap });

  let bootstrapSecrets = null;
  try {
    if (firebaseAdminSecretBootstrap) {
      bootstrapSecrets = await prepareFirebaseAdminBootstrapSecretsFile(serviceAccountPath, manifest);
    }
    const secretsArgs = versionUploadSecretsArgs(bootstrapSecrets?.secretsFile || '');
    runWrangler(manifest, [
      'versions', 'upload',
      '--config', configPath,
      '--keep-vars',
      '--strict',
      ...secretsArgs,
      '--dry-run',
      '--outdir', path.join(distributionRoot, 'dry-run'),
    ], { display: true });
    const revision = sourceSha.slice(0, 12);
    const upload = runWrangler(manifest, [
      'versions', 'upload',
      '--config', configPath,
      '--keep-vars',
      '--strict',
      ...secretsArgs,
      '--tag', `production-${revision}`,
      '--message', `Production candidate ${revision}; zero traffic`,
    ], { display: true });
    const candidateVersion = upload.match(/Worker Version ID:\s*([0-9a-f-]{36})/i)?.[1] || '';
    invariant(uuidPattern.test(candidateVersion), 'Wrangler did not return a candidate version ID');
    const candidate = versionView(manifest, candidateVersion);
    assertCandidateParity(activeVersion, candidate, manifest, { allowFirebaseAdminBootstrap: firebaseAdminSecretBootstrap });
    await verifyStagedCandidateWithRecovery({
      manifest,
      configPath,
      previousVersion,
      candidateVersion,
      sourceSha,
      subdomainSettings,
      firebaseAdminSecretBootstrap,
    });
    console.log(`CANDIDATE_READY: ${candidateVersion}`);
    console.log(`ROLLBACK_TARGET: ${previousVersion}`);
    console.log(`SOURCE_SHA: ${sourceSha}`);
  } finally {
    await bootstrapSecrets?.cleanup();
  }
}
function readOption(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : '';
}

function deploymentAlreadySafeForPrevious(deployment, previousVersion, candidateVersion) {
  try {
    assertSplit(deployment, new Map([[previousVersion, 100], [candidateVersion, 0]]));
    return true;
  } catch {}
  try {
    assertSplit(deployment, new Map([[previousVersion, 100]]));
    return true;
  } catch {}
  return false;
}

export async function promoteVerifiedCandidateWithRecovery({
  manifest,
  configPath,
  previousVersion,
  candidateVersion,
  deployTrafficFn = (versions, message) => runWrangler(manifest, [
    'versions', 'deploy',
    ...versions,
    '--config', configPath,
    '--name', manifest.worker.name,
    '--yes',
    '--message', message,
  ], { display: true }),
  deploymentStatusFn = () => deploymentStatus(manifest),
  httpSmokeFn = httpSmoke,
  browserSmokeFn = browserSmoke,
  postPromotionSmokeRetryDelaysMs = postPromotionSmokeRetryDelaysMs,
  sleepFn = sleep,
} = {}) {
  try {
    deployTrafficFn(
      [`${candidateVersion}@100%`],
      `Promote verified candidate ${candidateVersion}; rollback ${previousVersion}`,
    );
    assertSplit(deploymentStatusFn(), new Map([[candidateVersion, 100]]));
    await verifyPostPromotionSmokeWithRetry({
      manifest,
      httpSmokeFn,
      browserSmokeFn,
      retryDelaysMs: postPromotionSmokeRetryDelaysMs,
      sleepFn,
    });
  } catch (error) {
    try {
      let safeWithoutRollback = false;
      try {
        safeWithoutRollback = deploymentAlreadySafeForPrevious(
          deploymentStatusFn(),
          previousVersion,
          candidateVersion,
        );
      } catch {}

      if (!safeWithoutRollback) {
        let rollbackCommandError = null;
        try {
          deployTrafficFn(
            [`${previousVersion}@100%`],
            `Automatic rollback after failed promotion of ${candidateVersion}`,
          );
        } catch (rollbackError) {
          rollbackCommandError = rollbackError;
        }

        try {
          assertSplit(deploymentStatusFn(), new Map([[previousVersion, 100]]));
        } catch (rollbackVerificationError) {
          if (rollbackCommandError) {
            throw new AggregateError(
              [rollbackCommandError, rollbackVerificationError],
              'Rollback command and rollback verification both failed',
            );
          }
          throw rollbackVerificationError;
        }
      }
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'Promotion failed and deterministic recovery to the previous 100% version also failed',
      );
    }
    throw error;
  }
}

async function promote() {
  assertLocalOAuthOnly();
  const sourceSha = assertCleanGitHead();
  const initialManifest = validateManifest(await loadManifest());
  const state = await loadCandidateState(initialManifest);
  invariant(state.sourceSha === sourceSha, 'current Git HEAD differs from the staged candidate source SHA');
  const previousVersion = state.previousVersion;
  const candidateVersion = state.candidateVersion;
  invariant(readOption('approve') === candidateVersion, 'explicit local approval must be --approve <saved-candidate-version>');
  assertWranglerVersion(initialManifest);
  const oauthToken = readLocalOAuthToken(initialManifest);
  await assertRemoteObservabilityParity(initialManifest, { tokenProvider: () => oauthToken });
  const subdomainSettings = await readRemoteSubdomainSettings(initialManifest, { tokenProvider: () => oauthToken });
  assertSubdomainParity(subdomainSettings, state.subdomain);
  const { manifest, configPath } = await validateAll({ subdomainSettings });
  const active = versionView(manifest, previousVersion);
  const candidate = versionView(manifest, candidateVersion);
  assertCandidateParity(active, candidate, manifest, { allowFirebaseAdminBootstrap: state.firebaseAdminSecretBootstrap });
  assertSplit(deploymentStatus(manifest), new Map([[previousVersion, 100], [candidateVersion, 0]]));
  await httpSmoke(manifest, candidateVersion);
  await browserSmoke(manifest, candidateVersion);
  await promoteVerifiedCandidateWithRecovery({
    manifest,
    configPath,
    previousVersion,
    candidateVersion,
  });
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
