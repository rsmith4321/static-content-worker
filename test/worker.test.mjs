import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { run, readState, canonical, normalizeSnapshot, validateConfig, unlock } from '../src/worker.mjs';

const node = process.execPath;
const publicPost = (id, content = 'Original') => ({ id, status: 'publish', title: { rendered: `Post ${id}` }, content: { rendered: content }, featured_media: 0, categories: [], tags: [] });

async function fixture(t, sourceContent = { posts: [publicPost(1)], pages: [] }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'static-worker-')));
  const source = structuredClone(sourceContent);
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url);
    const name = url.pathname.split('/').at(-1);
    let records = source[name] ?? [];
    if (url.searchParams.has('include')) records = records.filter(record => url.searchParams.get('include').split(',').includes(String(record.id)));
    const perPage = Number(url.searchParams.get('per_page'));
    const page = Number(url.searchParams.get('page'));
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-wp-totalpages', String(Math.ceil(records.length / perPage)));
    res.end(JSON.stringify(records.slice((page - 1) * perPage, page * perPage)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const script = path.join(root, 'adapter.mjs');
  await writeFile(script, `
    import { appendFile, readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const stage = process.argv[2];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('CONTENT_')));
    await appendFile(path.join(process.cwd(), 'calls.jsonl'), JSON.stringify({stage, env, cwd:process.cwd(), argv:process.argv.slice(3)}) + '\\n');
    const snapshot = await readFile(env.CONTENT_SNAPSHOT, 'utf8');
    if (stage === 'build') await writeFile(path.join(env.CONTENT_CANDIDATE_DIR, 'output.txt'), snapshot);
    if (stage === 'publish') await writeFile(path.join(process.cwd(), 'published.txt'), snapshot);
    if (stage === 'verifyPublished' && await readFile(path.join(process.cwd(), 'published.txt'),'utf8') !== snapshot) process.exit(3);
    if (stage === 'rollback' && env.CONTENT_PREVIOUS_SNAPSHOT) await writeFile(path.join(process.cwd(),'published.txt'), await readFile(env.CONTENT_PREVIOUS_SNAPSHOT));
  `);
  const commands = Object.fromEntries(['build', 'verify', 'publish', 'verifyPublished', 'rollback'].map(stage => [stage, [node, script, stage]]));
  const config = { schemaVersion: 1, siteId: 'test-site', workingDir: root, stateDir: path.join(root, 'state'), candidateRoot: path.join(root, 'candidates'), source: { type: 'wordpress-rest', baseUrl: `http://127.0.0.1:${server.address().port}` }, commands };
  const calls = async () => { try { return (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { root, source, requests, config, calls, server };
}

test('canonical snapshots preserve richer fields, sort IDs/keys and reject private or duplicate records', () => {
  const original = { schemaVersion: 1, navigation: [{ label: 'Menu', children: [] }], site: { name: 'Site' }, collections: { posts: [publicPost(2), { ...publicPost(1), html: '<h1>Hello</h1>', blocks: [], meta: { custom: 1 } }] } };
  const result = normalizeSnapshot(original, { type: 'command' });
  assert.deepEqual(result.navigation, original.navigation);
  assert.deepEqual(result.site, original.site);
  assert.equal(result.collections.posts[0].html, '<h1>Hello</h1>');
  assert.deepEqual(result.collections.posts.map(record => record.id), [1, 2]);
  assert.equal(canonical({ z: 1, a: { y: 3, b: 2 } }), '{"a":{"b":2,"y":3},"z":1}');
  assert.throws(() => normalizeSnapshot({ schemaVersion: 1, collections: { posts: [{ id: 1, status: 'draft' }] } }, {}), /non-published/);
  assert.throws(() => normalizeSnapshot({ schemaVersion: 1, collections: { posts: [publicPost(1), publicPost(1)] } }, {}), /duplicate/);
});

test('first publication runs all stages and identical source skips commands without replacing state', async t => {
  const f = await fixture(t);
  const first = await run(f.config);
  assert.equal(first.status, 'published');
  assert.deepEqual((await f.calls()).map(call => call.stage), ['build', 'verify', 'publish', 'verifyPublished']);
  const stateText = await readFile(path.join(f.config.stateDir, 'state.json'), 'utf8');
  const second = await run(f.config);
  assert.equal(second.status, 'unchanged');
  assert.equal(second.hash, first.lastSuccessful.hash);
  assert.equal((await f.calls()).length, 4);
  assert.equal(await readFile(path.join(f.config.stateDir, 'state.json'), 'utf8'), stateText);
  assert.deepEqual(await readdir(f.config.candidateRoot), [path.basename(first.lastSuccessful.candidateDir)]);
  assert.ok(f.requests.every(url => !['posts', 'pages'].includes(url.pathname.split('/').at(-1)) || url.searchParams.get('status') === 'publish'));
});

test('modified and deleted content each publishes complete distinct snapshots and keeps previous candidates', async t => {
  const f = await fixture(t, { posts: [publicPost(1), publicPost(2)], pages: [] });
  const first = await run(f.config);
  f.source.posts[0].content.rendered = 'Modified';
  const second = await run(f.config);
  assert.notEqual(second.lastSuccessful.hash, first.lastSuccessful.hash);
  f.source.posts.splice(1, 1);
  const third = await run(f.config);
  assert.notEqual(third.lastSuccessful.hash, second.lastSuccessful.hash);
  assert.equal(JSON.parse(await readFile(third.lastSuccessful.snapshot, 'utf8')).collections.posts.length, 1);
  assert.equal(JSON.parse(await readFile(first.lastSuccessful.snapshot, 'utf8')).collections.posts.length, 2);
  assert.equal((await f.calls()).length, 12);
  assert.equal((await f.calls())[8].env.CONTENT_PREVIOUS_SNAPSHOT, second.lastSuccessful.snapshot);
});

test('referenced media and terms are fetched, metadata changes trigger updates, missing references abort', async t => {
  const f = await fixture(t, { posts: [{ ...publicPost(1), featured_media: 10, categories: [20], tags: [30] }], pages: [], media: [{ id: 10, source_url: 'https://example.org/a.jpg' }], categories: [{ id: 20, name: 'News' }], tags: [{ id: 30, name: 'Example' }] });
  const first = await run(f.config);
  const snapshot = JSON.parse(await readFile(first.lastSuccessful.snapshot, 'utf8'));
  assert.equal(snapshot.collections.media[0].id, 10);
  assert.equal(snapshot.collections.categories[0].id, 20);
  f.source.media[0].source_url = 'https://example.org/b.jpg';
  const second = await run(f.config);
  assert.notEqual(second.lastSuccessful.hash, first.lastSuccessful.hash);
  f.source.tags = [];
  await assert.rejects(run(f.config), /missing referenced/);
  assert.deepEqual(await readState(validateConfig(f.config)), { schemaVersion: second.schemaVersion, siteId: second.siteId, lastSuccessful: second.lastSuccessful });
});

for (const failedStage of ['build', 'verify', 'publish', 'verifyPublished']) {
  test(`${failedStage} failure preserves state and prior snapshot; rollback restores fixture publication if needed`, async t => {
    const f = await fixture(t);
    const first = await run(f.config);
    const stateText = await readFile(path.join(f.config.stateDir, 'state.json'), 'utf8');
    f.source.posts[0].content.rendered = 'Next';
    f.config.commands[failedStage] = [node, '-e', 'process.exit(17)'];
    await assert.rejects(run(f.config), new RegExp(`${failedStage} failed \\(17\\)`));
    assert.equal(await readFile(path.join(f.config.stateDir, 'state.json'), 'utf8'), stateText);
    assert.equal(await readFile(path.join(f.root, 'published.txt'), 'utf8'), await readFile(first.lastSuccessful.snapshot, 'utf8'));
    const dirs = await readdir(f.config.candidateRoot);
    assert.equal(dirs.length, 2);
    const failedDir = dirs.find(dir => dir !== path.basename(first.lastSuccessful.candidateDir));
    const failure = JSON.parse(await readFile(path.join(f.config.candidateRoot, failedDir, 'failure.json'), 'utf8'));
    assert.equal(failure.stage, failedStage);
    const calls = await f.calls();
    assert.equal(calls.at(-1).stage === 'rollback', ['publish', 'verifyPublished'].includes(failedStage));
    await assert.rejects(readFile(path.join(f.config.stateDir, 'run.lock', 'owner.json')), { code: 'ENOENT' });
  });
}

test('state advances only after public verification completes', async t => {
  const f = await fixture(t);
  const gate = path.join(f.root, 'gate');
  f.config.commands.verifyPublished = [node, '-e', `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(gate)},'entered'); setTimeout(()=>process.exit(0),400)`];
  const running = run(f.config);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(gate); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(await readFile(gate, 'utf8'), 'entered');
  assert.equal(await readState(validateConfig(f.config)), null);
  const completed = await running;
  assert.equal((await readState(validateConfig(f.config))).lastSuccessful.hash, completed.lastSuccessful.hash);
});

test('commands receive real absolute staged paths, cwd, previous snapshot and literal argv', async t => {
  const f = await fixture(t);
  const literal = '$(touch should-not-exist);`whoami`';
  f.config.commands.build.push(literal);
  const first = await run(f.config);
  const calls = await f.calls();
  assert.equal(calls[0].cwd, f.root);
  assert.deepEqual(calls[0].argv, [literal]);
  for (const { env } of calls) {
    assert.equal(env.CONTENT_SNAPSHOT, first.lastSuccessful.snapshot);
    assert.equal(env.CONTENT_CANDIDATE_DIR, first.lastSuccessful.candidateDir);
    assert.equal(env.CONTENT_PREVIOUS_SNAPSHOT, '');
    assert.equal(env.CONTENT_SITE_ID, 'test-site');
    assert.equal(env.CONTENT_HASH, first.lastSuccessful.hash);
    assert.ok(path.isAbsolute(env.CONTENT_SNAPSHOT));
  }
  await assert.rejects(readFile(path.join(f.root, 'should-not-exist')), { code: 'ENOENT' });
});

test('one lock rejects concurrent run and refuses unlocking a live local owner', async t => {
  const f = await fixture(t);
  f.config.commands.build = [node, '-e', 'setTimeout(()=>process.exit(0),350)'];
  const running = run(f.config);
  const owner = path.join(f.config.stateDir, 'run.lock', 'owner.json');
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(owner); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  await assert.rejects(run(f.config), /holds the lock/);
  await assert.rejects(unlock(validateConfig(f.config), true), /still running/);
  await running;
});

test('timeout, failed export, malformed export, and oversized output never publish', async t => {
  const f = await fixture(t);
  f.config.source = { type: 'command', exportCommand: [node, '-e', 'setTimeout(()=>{},10000)'] };
  f.config.limits = { commandTimeoutMs: 100 };
  await assert.rejects(run(f.config), /exceeded commandTimeoutMs/);
  f.config.source.exportCommand = [node, '-e', 'process.exit(9)'];
  await assert.rejects(run(f.config), /export failed/);
  f.config.source.exportCommand = [node, '-e', 'console.log("not json")'];
  await assert.rejects(run(f.config), /Unexpected token/);
  f.config.limits.maxCommandOutputBytes = 100;
  f.config.source.exportCommand = [node, '-e', 'console.log("a".repeat(101))'];
  await assert.rejects(run(f.config), /maxCommandOutputBytes/);
  assert.deepEqual(await f.calls(), []);
  assert.equal(await readState(validateConfig(f.config)), null);
});

test('trusted command export retains rich metadata, no-change normalization ignores key/record order', async t => {
  const f = await fixture(t);
  const exported = path.join(f.root, 'export.json');
  const value = { schemaVersion: 1, source: { baseUrl: 'https://example.org' }, site: { name: 'Example' }, navigation: [{ title: 'Home' }], routes: ['/', '/hello/'], preservation: { html: 'Exact' }, collections: { posts: [publicPost(2), publicPost(1)] } };
  await writeFile(exported, JSON.stringify(value));
  f.config.source = { type: 'command', exportCommand: [node, '-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(exported)}))`] };
  const first = await run(f.config);
  const snapshot = JSON.parse(await readFile(first.lastSuccessful.snapshot, 'utf8'));
  assert.deepEqual(snapshot.routes, value.routes);
  assert.deepEqual(snapshot.preservation, value.preservation);
  value.collections.posts.reverse();
  await writeFile(exported, JSON.stringify({ collections: value.collections, ...value }));
  assert.equal((await run(f.config)).status, 'unchanged');
});

test('REST pagination and response limits abort instead of publishing partial content', async t => {
  const f = await fixture(t, { posts: [publicPost(1), publicPost(2), publicPost(3)], pages: [] });
  f.config.limits = { pageSize: 1, maxPages: 2 };
  await assert.rejects(run(f.config), /pagination exceeds bounds/);
  f.config.limits = { maxRecords: 2 };
  await assert.rejects(run(f.config), /maxRecords/);
  f.config.limits = { maxResponseBytes: 10 };
  await assert.rejects(run(f.config), /maxResponseBytes/);
  f.config.limits = { pageSize: 1 };
  const complete = await run(f.config);
  assert.equal(JSON.parse(await readFile(complete.lastSuccessful.snapshot, 'utf8')).collections.posts.length, 3);
});

test('mutated candidate snapshot fails before publication and corrupt previous snapshot fails before commands', async t => {
  const f = await fixture(t);
  const originalBuild = f.config.commands.build;
  f.config.commands.build = [node, '-e', 'require("node:fs").writeFileSync(process.env.CONTENT_SNAPSHOT,"{}")'];
  await assert.rejects(run(f.config), /changed the input snapshot/);
  assert.equal(await readState(validateConfig(f.config)), null);
  f.config.commands.build = originalBuild;
  const first = await run(f.config);
  await writeFile(first.lastSuccessful.snapshot, '{}');
  await assert.rejects(run(f.config), /snapshot is missing or changed/);
  assert.equal((await f.calls()).length, 4);
});

test('rollback failure is reported without state advancement', async t => {
  const f = await fixture(t);
  f.config.commands.publish = [node, '-e', 'process.exit(8)'];
  f.config.commands.rollback = [node, '-e', 'process.exit(7)'];
  await assert.rejects(run(f.config), /rollback also failed: rollback failed \(7\)/);
  assert.equal(await readState(validateConfig(f.config)), null);
});

test('failed initial state write invokes rollback after verification and retains recovery evidence', async t => {
  const f = await fixture(t);
  const statePath = path.join(f.config.stateDir, 'state.json');
  f.config.commands.verifyPublished = [node, '-e', `require('node:fs').mkdirSync(${JSON.stringify(statePath)})`];
  await assert.rejects(run(f.config), /EISDIR|EPERM|ENOTDIR/);
  assert.equal((await f.calls()).at(-1).stage, 'rollback');
  const dirs = await readdir(f.config.candidateRoot);
  const failure = JSON.parse(await readFile(path.join(f.config.candidateRoot, dirs[0], 'failure.json'), 'utf8'));
  assert.equal(failure.stage, 'state');
  await rm(statePath, { recursive: true });
  assert.equal(await readState(validateConfig(f.config)), null);
});

test('HTTP errors, malformed JSON and body timeouts retain previous success', async t => {
  const f = await fixture(t);
  const first = await run(f.config);
  const stateText = await readFile(path.join(f.config.stateDir, 'state.json'), 'utf8');
  f.server.removeAllListeners('request');
  f.server.on('request', (req, res) => { res.writeHead(503); res.end('Unavailable'); });
  await assert.rejects(run(f.config), /HTTP 503/);
  f.server.removeAllListeners('request');
  f.server.on('request', (req, res) => { res.end('{broken'); });
  await assert.rejects(run(f.config), /JSON|Expected/);
  f.server.removeAllListeners('request');
  f.server.on('request', (req, res) => { res.writeHead(200); res.write('['); });
  f.config.limits = { requestTimeoutMs: 50 };
  await assert.rejects(run(f.config), /abort/i);
  assert.equal(await readFile(path.join(f.config.stateDir, 'state.json'), 'utf8'), stateText);
  assert.equal((await readState(validateConfig(f.config))).lastSuccessful.hash, first.lastSuccessful.hash);
});

test('a stale lock requires explicit recovery and a retry succeeds', async t => {
  const f = await fixture(t);
  const lock = path.join(f.config.stateDir, 'run.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ hostname: 'stopped-other-host', pid: 99 }));
  await assert.rejects(run(f.config), /holds the lock/);
  await assert.rejects(unlock(validateConfig(f.config), false), /requires --force/);
  assert.equal((await unlock(validateConfig(f.config), true)).status, 'unlocked');
  assert.equal((await run(f.config)).status, 'published');
});

test('invalid config fails before paths or commands are used', () => {
  assert.throws(() => validateConfig({ schemaVersion: 1, siteId: '../escape' }), /siteId/);
  assert.throws(() => validateConfig({ schemaVersion: 1, siteId: 'test', workingDir: 'relative' }), /workingDir must be absolute/);
});

test('CLI prints valid JSON status and fails missing configuration', async t => {
  const f = await fixture(t);
  const configPath = path.join(f.root, 'config.json');
  await writeFile(configPath, JSON.stringify(f.config));
  const cli = path.resolve('bin/static-content-worker.mjs');
  const child = spawn(node, [cli, 'run', '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).status, 'published');
  const missing = spawn(node, [cli, 'run'], { stdio: ['ignore', 'pipe', 'pipe'] });
  missing.stderr.resume();
  assert.equal((await once(missing, 'close'))[0], 1);
});
