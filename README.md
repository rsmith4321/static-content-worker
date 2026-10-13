# Static Content Worker

A small Node.js 22+ command-line worker that takes complete public WordPress content snapshots and invokes an existing static site's build, verification and publication commands. It has no runtime packages, AI service, ShootCal dependency, or per-run fee. Your hosting and source services may have their own costs.

The worker supplies content and orchestration. Bring your own renderer and release adapter. It does not export a WordPress theme, install cron, choose a hosting provider, or publish directly to a particular service.

## Run

Copy `examples/site.example.json` outside the repository and replace its paths, source URL and argv commands. These example scripts are adapter placeholders, not included implementations.

```sh
node bin/static-content-worker.mjs run --config /etc/static-content-worker/site.json
node bin/static-content-worker.mjs status --config /etc/static-content-worker/site.json
npm test
```

All configuration paths must be absolute. Every site needs its own `siteId`, `stateDir` and `candidateRoot`. Commands run from `workingDir`. Use the same state directory for all runners of one site, on a filesystem whose directory creation is atomic. Separate state directories do not provide a cross-host publication lock. Do not change a site's source/configuration while it is running.

Successful changed runs return JSON with `status: "published"`. Identical normalized content returns `status: "unchanged"` without invoking build or publication. Both exit 0. Failures, invalid config and concurrent runs exit 1; inspect stderr and the retained candidate's `failure.json`. A successful state does not independently prove a public deployment: the adapter's `verifyPublished` command supplies that evidence.

## WordPress source

`source.type: "wordpress-rest"` reads the public REST API below `source.baseUrl` (the WordPress site URL, including a subdirectory if applicable). It reads published `posts` and `pages` by default, with `context=view`, stable ID ordering and bounded pagination. `resources` can select either or both. It fetches referenced featured media, categories and tags only as needed. It does not download image binaries or transform media; the build adapter owns that pipeline.

This uses complete snapshots, so modifications, unpublished/deleted records, changed titles/URLs/content and changed referenced metadata change the hash. The source must expose the requested public endpoints. HTTP failures, invalid/non-public records, missing referenced records, duplicate IDs, changing page counts and limit overruns fail the run. Nothing advances on a partial export. WordPress does not provide a transactional REST snapshot across all requests; run again after source editing settles if concurrent edits cause an incomplete snapshot. URLs must respond directly; redirects are rejected. HTTPS is recommended outside local testing.

The default limits are shown in the example config. `maxRecords` bounds each REST collection, `maxPages` bounds each paginated request series, `maxResponseBytes` bounds each response, and `requestTimeoutMs` bounds the entire response including its body. `pageSize` must be 1–100. A run fetches the source each time; it does not assume a modification date is enough to detect deletion. A missing REST pagination header is supported only when a final short page establishes completion.

## Rich operator-owned export

For menus, SEO plugin fields, custom fields, rendered blocks, HTML, forms or other data absent from the public endpoints, use an export adapter:

```json
{
  "source": {
    "type": "command",
    "exportCommand": ["node", "scripts/export-wordpress.mjs"]
  }
}
```

This replaces the `source` entry in a complete config. The trusted command runs once and must write exactly one JSON object to stdout. Write diagnostics to stderr. It can invoke local WP-CLI or another operator-approved export mechanism. Keep provider secrets in the host's credential store or process environment, out of this public repository and snapshots. Run as an account with only the access the adapter requires.

The required export shape is:

```json
{
  "schemaVersion": 1,
  "source": { "baseUrl": "https://wordpress.example.org" },
  "collections": {
    "posts": [{ "id": 12, "status": "publish", "title": { "rendered": "Hello" } }],
    "pages": [],
    "media": [],
    "categories": [],
    "tags": []
  }
}
```

All collection records need unique positive integer `id` values. Posts/pages must have `status: "publish"`. Missing standard collections become empty arrays; additional named collections and additional fields at every level survive normalization. Source `type` is set to `command` or `wordpress-rest` to identify the transport. Arrays outside collections retain their ordering. Do not include volatile export timestamps or random values: they would trigger a daily build. `maxCommandOutputBytes` bounds combined stdout/stderr from every command, including the exporter.

## Adapter command contract

Required argv arrays are `commands.build`, `commands.verify`, `commands.publish` and `commands.verifyPublished`, in that order. An exit code other than 0 or a timeout fails the run. All commands use `shell: false`; no WordPress text is interpolated into commands, argv or a shell. An operator can explicitly configure a shell as an executable, but that shell script remains trusted operator code. Treat all content as untrusted input in your renderer and export adapter.

Every command inherits the runner's environment plus these values:

| Variable | Meaning |
| --- | --- |
| `CONTENT_SNAPSHOT` | Absolute canonical JSON input path in this run's candidate directory. During export it names the future output file. |
| `CONTENT_CANDIDATE_DIR` | Absolute, unique directory for this run's build artifacts and release receipt. |
| `CONTENT_WORKING_DIR` | Absolute configured command working directory. |
| `CONTENT_PREVIOUS_SNAPSHOT` | Last successful snapshot path, or an empty string on the first run. |
| `CONTENT_SITE_ID` | Configured site identifier. |
| `CONTENT_HASH` | SHA-256 of canonical snapshot JSON, empty during export. |

Read `CONTENT_SNAPSHOT` as data; keep it unchanged. Build output belongs under `CONTENT_CANDIDATE_DIR` in separate files. The worker checks the snapshot after each command. Keep authored source files and the current live release outside the candidate output. Your build must preserve unrelated authored content, URLs, forms, media and SEO as required by your site's contract.

`verify` should check the complete candidate, including content/route preservation and media. `publish` must activate a fully prepared release atomically, retain a recoverable previous release and write a candidate-local receipt that `verifyPublished` can check. `verifyPublished` should test the deployed release and expected content/hash using the actual provider or public endpoint. Make publication idempotent: a crash after activation but before state writing means a later run can try publishing the same content again.

The worker cannot undo arbitrary side effects in commands. Configure optional `commands.rollback` to restore the prior release using adapter-owned recovery metadata. It runs if publication has started and publication, the public check, snapshot integrity, or state writing fails. A rollback error is reported alongside the original error. The adapter must verify restoration itself and handle its first publication case. A build or pre-publication verification failure never invokes rollback. Rollback is not automatic evidence of live restoration.

## State, retention and recovery

`stateDir/state.json` is replaced atomically only after all required commands succeed and the input snapshot remains unchanged. It records the last successful hash, snapshot, candidate path and completion time. Until then, the existing state is untouched. The worker validates the prior snapshot before using its hash. State temp files use private modes; no content backups are put under a public webroot by the worker. Do not place state or candidate roots inside your public webroot.

Failed runs retain their own candidate, snapshot when available, `run.json` and `failure.json`. The last successful candidate is never overwritten. No automatic pruning runs; operators can remove old failed/previous candidates after preserving required recovery evidence. Keep the candidate referenced by `state.json`. An unchanged run deletes only its newly created unused candidate.

A `stateDir/run.lock` directory protects one run per state directory. Its `owner.json` records PID, hostname and start time. Normal success/failure releases it. A killed process or host crash can leave a stale lock; the worker never guesses that it is safe to steal it. After confirming the owner and all child commands have stopped:

```sh
node bin/static-content-worker.mjs unlock --config /etc/static-content-worker/site.json --force
```

Unlock refuses a known live local PID. Hostnames/PIDs are informational across hosts; operator confirmation is still required. Restore a missing/corrupted successful snapshot from your backups before running again. Do not edit the hash to silence the check.

The worker forcibly terminates a timed-out command's process group on Unix. On Windows it terminates the direct child; adapters must manage any descendants they launch. An abruptly killed runner may leave command processes running. Inspect them before lock recovery. Limits apply per command, not to the entire pipeline. Commands' stdout is discarded except JSON export; stderr tails are included in errors, so adapters must avoid printing secrets.

## Daily scheduling

Use `examples/cron.example` as an operator-edited server cron example. It is not installed by the CLI. Test the same host account, executable paths, credentials, environment and working directory manually before installing the schedule. Avoid scheduling overlapping independent runners against the same destination. Keep logs and retained snapshots private. Node.js and the site's build/runtime tools must already be installed.

## Development and scope

The tests use temporary local WordPress-like HTTP endpoints and actual child processes; they never deploy or contact a real provider. `npm test` exercises change/deletion detection, stable snapshots, stage failures, state advancement, rollback, concurrency, environment, limits and timeouts. Passing these tests is local evidence only. Provider adapters and independent security review need their own verification.

MIT licensed. No deployment, GitHub publication or scheduler changes are performed by this package itself.
