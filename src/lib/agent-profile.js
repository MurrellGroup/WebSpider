import path from 'node:path';

export const AUTONOMOUS_CODEX_ARGUMENTS = Object.freeze([
  '--ask-for-approval',
  'never',
  '--sandbox',
  'danger-full-access',
]);

export function agentLaunchArguments(executable, argumentsList = []) {
  const configured = Array.isArray(argumentsList) ? argumentsList : [];
  if (configured.length > 0) return [...configured];
  const name = path.basename(String(executable || '')).toLowerCase();
  return name.includes('codex') ? [...AUTONOMOUS_CODEX_ARGUMENTS] : configured;
}
