import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const collections = ['posts', 'pages', 'media', 'categories', 'tags'];
const stages = ['build', 'verify', 'publish', 'verifyPublished'];
const defaults = { maxPages: 100, maxRecords: 10000, pageSize: 100, requestTimeoutMs: 30000, maxResponseBytes: 10000000, commandTimeoutMs: 300000, maxCommandOutputBytes: 50000000 };

function argv(value, name) {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || item.includes('\0')) || !value[0]) throw new Error(`${name} must be a nonempty argv string array`);
}

export async function loadConfig(filename) {
  if (!path.isAbsolute(filename)) throw new Error('Config path must be absolute');
  const config = JSON.parse(await readFile(filename, 'utf8'));
  return validateConfig(config);
}

export function validateConfig(input) {
  const config = { ...input, limits: { ...defaults, ...input.limits } };
  if (config.schemaVersion !== 1) throw new Error('Config schemaVersion must be 1');
  if (typeof config.siteId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(config.siteId)) throw new Error('siteId must be a short filename-safe identifier');
  for (const key of ['workingDir', 'stateDir', 'candidateRoot']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error(`${key} must be absolute`);
    config[key] = path.resolve(config[key]);
  }
  if (config.stateDir === config.candidateRoot) throw new Error('stateDir and candidateRoot must differ');
  for (const [key, value] of Object.entries(config.limits)) {
    if (!(key in defaults) || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid limit: ${key}`);
  }
  if (config.limits.pageSize > 100) throw new Error('pageSize must be at most 100');
  if (!config.source || !['wordpress-rest', 'command'].includes(config.source.type)) throw new Error('source.type must be wordpress-rest or command');
  if (config.source.type === 'command') argv(config.source.exportCommand, 'source.exportCommand');
  else {
    const url = new URL(config.source.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('source.baseUrl must be an HTTP(S) URL without credentials, query or fragment');
    config.source = { ...config.source, baseUrl: url.href.replace(/\/$/, ''), resources: config.source.resources ?? ['posts', 'pages'] };
    if (!Array.isArray(config.source.resources) || !config.source.resources.length || config.source.resources.some(item => !['posts', 'pages'].includes(item)) || new Set(config.source.resources).size !== config.source.resources.length) throw new Error('source.resources must contain unique posts and/or pages');
  }
  for (const stage of stages) argv(config.commands?.[stage], `commands.${stage}`);
  if (config.commands.rollback !== undefined) argv(config.commands.rollback, 'commands.rollback');
  return config;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function normalizeSnapshot(value, source) {
  if (!value || value.schemaVersion !== 1 || !value.collections || typeof value.collections !== 'object' || Array.isArray(value.collections)) throw new Error('Export must have schemaVersion: 1 and a collections object');
  const normalized = {};
  for (const name of [...new Set([...collections, ...Object.keys(value.collections)])].sort()) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid collection name: ${name}`);
    const records = value.collections[name] ?? [];
    if (!Array.isArray(records)) throw new Error(`Collection ${name} must be an array`);
    const ids = new Set();
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || !Number.isSafeInteger(record.id) || record.id < 1 || ids.has(record.id)) throw new Error(`Collection ${name} has an invalid or duplicate record id`);
      if (['posts', 'pages'].includes(name) && record.status !== 'publish') throw new Error(`Collection ${name} includes non-published content`);
      ids.add(record.id);
    }
    normalized[name] = [...records].sort((a, b) => a.id - b.id);
  }
  return { ...value, schemaVersion: 1, source: { ...value.source, ...source }, collections: normalized };
}

async function fetchJSON(url, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.limits.requestTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' }, redirect: 'error' });
    if (!response.ok) throw new Error(`WordPress returned HTTP ${response.status} for ${url.pathname}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > config.limits.maxResponseBytes) { controller.abort(); throw new Error('WordPress response exceeds maxResponseBytes'); }
      chunks.push(chunk);
    }
    return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), pages: response.headers.get('x-wp-totalpages') };
  } finally { clearTimeout(timer); }
}

async function fetchCollection(config, resource, include) {
  const records = [];
  let totalPages;
  for (let page = 1; page <= config.limits.maxPages; page++) {
    const url = new URL(`${config.source.baseUrl}/wp-json/wp/v2/${resource}`);
    url.searchParams.set('context', 'view');
    url.searchParams.set('per_page', String(config.limits.pageSize));
    url.searchParams.set('page', String(page));
    url.searchParams.set('orderby', 'id');
    url.searchParams.set('order', 'asc');
    if (['posts', 'pages'].includes(resource)) url.searchParams.set('status', 'publish');
    if (include) url.searchParams.set('include', include.join(','));
    const result = await fetchJSON(url, config);
    if (!Array.isArray(result.data)) throw new Error(`WordPress ${resource} did not return an array`);
    if (result.pages !== null) {
      const count = Number(result.pages);
      if (!/^\d+$/.test(result.pages) || !Number.isSafeInteger(count) || count > config.limits.maxPages) throw new Error(`WordPress ${resource} pagination exceeds bounds or is invalid`);
      if (totalPages !== undefined && totalPages !== count) throw new Error(`WordPress ${resource} changed during pagination; retry the run`);
      totalPages = count;
    }
    records.push(...result.data);
    if (records.length > config.limits.maxRecords) throw new Error(`WordPress ${resource} exceeds maxRecords`);
    if (totalPages !== undefined ? page >= totalPages : result.data.length < config.limits.pageSize) return records;
  }
  throw new Error(`WordPress ${resource} exceeded maxPages without a complete snapshot`);
}

async function fetchReferenced(config, name, ids) {
  const result = [];
  const unique = [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
  if (unique.length > config.limits.maxRecords) throw new Error(`${name} references exceed maxRecords`);
  for (let offset = 0; offset < unique.length; offset += config.limits.pageSize) result.push(...await fetchCollection(config, name, unique.slice(offset, offset + config.limits.pageSize)));
  // Deleted/missing media or terms must not silently remove information from an otherwise successful update.
  if (result.length !== unique.length || unique.some(id => !result.some(record => record.id === id))) throw new Error(`WordPress ${name} is missing referenced records`);
  return result;
}

async function exportSnapshot(config, env) {
  if (config.source.type === 'command') {
    const output = await execute(config.source.exportCommand, config, env, 'export', true);
    return normalizeSnapshot(JSON.parse(output), { type: 'command' });
  }
  const data = {};
  for (const resource of config.source.resources) data[resource] = await fetchCollection(config, resource);
  const content = [...(data.posts ?? []), ...(data.pages ?? [])];
  data.media = await fetchReferenced(config, 'media', content.map(record => record.featured_media));
  data.categories = await fetchReferenced(config, 'categories', content.flatMap(record => record.categories ?? []));
  data.tags = await fetchReferenced(config, 'tags', content.flatMap(record => record.tags ?? []));
  return normalizeSnapshot({ schemaVersion: 1, collections: data }, { type: 'wordpress-rest', baseUrl: config.source.baseUrl });
}

export async function execute(command, config, env, stage, capture = false) {
  return await new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command[0], command.slice(1), { cwd: config.workingDir, env: { ...process.env, ...env }, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(new Error(`${stage} could not start: ${error.message}`)); return; }
    let output = [], bytes = 0, stderr = '', failure;
    const stop = reason => {
      failure ??= reason;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* process may have exited */ }
    };
    const timer = setTimeout(() => stop(`${stage} exceeded commandTimeoutMs`), config.limits.commandTimeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > config.limits.maxCommandOutputBytes) stop(`${stage} output exceeds maxCommandOutputBytes`);
      else if (capture) output.push(chunk);
    });
    child.stderr.on('data', chunk => {
      bytes += chunk.length;
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
      if (bytes > config.limits.maxCommandOutputBytes) stop(`${stage} output exceeds maxCommandOutputBytes`);
    });
    child.on('error', error => { clearTimeout(timer); reject(new Error(`${stage} could not start: ${error.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(new Error(failure ?? `${stage} failed (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}`));
      else resolve(capture ? Buffer.concat(output).toString('utf8') : undefined);
    });
  });
}

async function atomicJSON(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${canonical(value)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temp, filename); }
  finally { await rm(temp, { force: true }); }
}

export async function readState(config) {
  try {
    const state = JSON.parse(await readFile(path.join(config.stateDir, 'state.json'), 'utf8'));
    if (state.schemaVersion !== 1 || state.siteId !== config.siteId || !state.lastSuccessful?.hash || !path.isAbsolute(state.lastSuccessful.snapshot)) throw new Error('State schema or siteId mismatch');
    return state;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function unlock(config, force) {
  if (!force) throw new Error('unlock requires --force after confirming the previous run has stopped');
  const lock = path.join(config.stateDir, 'run.lock');
  let owner;
  try { owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (owner?.hostname === hostname() && Number.isInteger(owner.pid)) {
    try { process.kill(owner.pid, 0); throw new Error('Lock owner process is still running; stop it before unlocking'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await rm(lock, { recursive: true, force: true });
  return { status: 'unlocked', siteId: config.siteId };
}

export async function run(input) {
  const config = validateConfig(input);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(config.stateDir, 'run.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another run holds the lock; inspect run.lock/owner.json before recovery'); throw error; }
  let candidate, stage = 'initialize', published = false, env;
  try {
    await atomicJSON(path.join(lock, 'owner.json'), { pid: process.pid, hostname: hostname(), siteId: config.siteId, startedAt: new Date().toISOString() });
    const previous = await readState(config);
    const previousSnapshot = previous?.lastSuccessful.snapshot ?? '';
    if (previousSnapshot) {
      const previousData = await readFile(previousSnapshot, 'utf8');
      if (createHash('sha256').update(previousData.trim()).digest('hex') !== previous.lastSuccessful.hash) throw new Error('Last successful snapshot is missing or changed; restore it before running');
    }
    await mkdir(config.candidateRoot, { recursive: true, mode: 0o700 });
    candidate = path.join(config.candidateRoot, `${config.siteId}-${randomUUID()}`);
    await mkdir(candidate, { mode: 0o700 });
    env = { CONTENT_SNAPSHOT: path.join(candidate, 'snapshot.json'), CONTENT_CANDIDATE_DIR: candidate, CONTENT_WORKING_DIR: config.workingDir, CONTENT_PREVIOUS_SNAPSHOT: previousSnapshot, CONTENT_SITE_ID: config.siteId, CONTENT_HASH: '' };
    stage = 'export';
    const snapshot = await exportSnapshot(config, env);
    const serialized = canonical(snapshot);
    const hash = createHash('sha256').update(serialized).digest('hex');
    if (previous?.lastSuccessful.hash === hash) {
      await rm(candidate, { recursive: true });
      return { status: 'unchanged', siteId: config.siteId, hash };
    }
    env.CONTENT_HASH = hash;
    await writeFile(env.CONTENT_SNAPSHOT, `${serialized}\n`, { mode: 0o600, flag: 'wx' });
    await atomicJSON(path.join(candidate, 'run.json'), { schemaVersion: 1, siteId: config.siteId, hash, previousSnapshot, startedAt: new Date().toISOString() });
    for (stage of stages) {
      if (stage === 'publish') published = true;
      await execute(config.commands[stage], config, env, stage);
      const currentSnapshot = await readFile(env.CONTENT_SNAPSHOT, 'utf8');
      if (createHash('sha256').update(currentSnapshot.trim()).digest('hex') !== hash) throw new Error(`${stage} changed the input snapshot`);
    }
    stage = 'state';
    const state = { schemaVersion: 1, siteId: config.siteId, lastSuccessful: { hash, snapshot: env.CONTENT_SNAPSHOT, candidateDir: candidate, completedAt: new Date().toISOString() } };
    await atomicJSON(path.join(config.stateDir, 'state.json'), state);
    return { status: 'published', ...state };
  } catch (error) {
    let rollbackError;
    if (published && config.commands.rollback) {
      try { await execute(config.commands.rollback, config, env, 'rollback'); }
      catch (failure) { rollbackError = failure.message; }
    }
    if (candidate) {
      try { await atomicJSON(path.join(candidate, 'failure.json'), { stage, error: error.message, rollbackError: rollbackError ?? null, failedAt: new Date().toISOString() }); } catch { /* preserve original failure */ }
    }
    throw new Error(`${error.message}${candidate ? `; candidate retained at ${candidate}` : ''}${rollbackError ? `; rollback also failed: ${rollbackError}` : ''}`);
  } finally { await rm(lock, { recursive: true, force: true }); }
}
