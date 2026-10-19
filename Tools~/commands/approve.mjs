import { listScreens, loadCheckpoints, loadProject, saveCheckpoints } from '../lib/project.mjs';
import { writeState } from '../lib/state.mjs';
import { fail } from '../lib/util.mjs';
import { approvalHashes } from './plan.mjs';

/**
 * uikit approve spec|assets|<screen> [--revoke]
 * Records a user checkpoint in UIKit/checkpoints.json with a hash of what was approved, so
 * `uikit plan` unblocks the next phase and asks again if that content changes later.
 * Run it only after the user said yes in chat. "screen:<name>" also works (for a screen named spec/assets).
 */
export default async function approve(args) {
  const project = loadProject(args.project);
  // `approve --revoke home` parses "home" as the flag's value.
  const target = args._[1] ?? (typeof args.revoke === 'string' ? args.revoke : null) ?? fail('usage: uikit approve spec|assets|<screen> [--revoke]');
  const revoke = Boolean(args.revoke);
  const checkpoints = loadCheckpoints(project);
  const hashes = approvalHashes(project);
  const entry = (hash) => (revoke ? undefined : { at: new Date().toISOString(), hash });

  const screenName = target.startsWith('screen:') ? target.slice('screen:'.length) : null;
  if (!screenName && (target === 'spec' || target === 'assets')) checkpoints[target] = entry(hashes[target]);
  else {
    const name = screenName ?? target;
    if (!listScreens(project).includes(name)) fail(`unknown checkpoint "${target}": use spec, assets or one of: ${listScreens(project).join(', ')}`);
    if (!revoke && !hashes.screens[name]) fail(`screen "${name}" has no scene or prefab yet; nothing to approve`);
    checkpoints.screens[name] = entry(hashes.screens[name]);
    // A decision by the user starts a fresh fix-round count for later changes.
    writeState(project, `iterations-${name}`, { count: 0, lastInputs: null });
  }

  saveCheckpoints(project, JSON.parse(JSON.stringify(checkpoints)));
  console.log(`${target}: ${revoke ? 'revoked' : 'approved'}`);
}
