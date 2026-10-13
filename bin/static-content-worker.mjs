#!/usr/bin/env node
import { loadConfig, run, readState, unlock } from '../src/worker.mjs';

const [action = 'help', ...args] = process.argv.slice(2);
if (action === 'help' || args.includes('--help')) {
  console.log('Usage: static-content-worker <run|status|unlock> --config /absolute/site.json [--force]\nNode.js 22+. unlock requires --force and an operator-confirmed stopped run.');
} else {
  const controller = new AbortController();
  let interrupted = 0;
  const onInterrupt = signal => {
    interrupted ||= signal === 'SIGINT' ? 130 : 143;
    controller.abort(new Error(`received ${signal}`));
  };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    if (!['run', 'status', 'unlock'].includes(action)) throw new Error(`Unknown action: ${action}`);
    const index = args.indexOf('--config');
    if (index < 0 || !args[index + 1]) throw new Error('--config is required');
    if (args.some((arg, i) => i !== index && i !== index + 1 && arg !== '--force')) throw new Error('Unknown argument');
    const config = await loadConfig(args[index + 1]);
    const result = action === 'run' ? await run(config, { signal: controller.signal })
      : action === 'status' ? await readState(config)
        : await unlock(config, args.includes('--force'));
    if (interrupted) throw new Error('operation aborted');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`static-content-worker: ${error.message}`);
    process.exitCode = interrupted || 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
