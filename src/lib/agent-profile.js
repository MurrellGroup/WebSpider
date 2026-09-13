import path from 'node:path';

export const AUTONOMOUS_CODEX_ARGUMENTS = Object.freeze([
  '--ask-for-approval',
  'never',
  '--sandbox',
  'danger-full-access',
]);

export const CODEX_STABLE_MODEL_ARGUMENTS = Object.freeze([
  '-c',
  'notice.hide_rate_limit_model_nudge=true',
  '-c',
  'tui.keymap.composer.submit=["enter","ctrl-enter"]',
]);

const CODEX_STABLE_MODEL_KEYS = new Set([
  'notice.hide_rate_limit_model_nudge',
  'tui.keymap.composer.submit',
]);

function withoutOverriddenCodexConfig(argumentsList) {
  const result = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (['-c', '--config'].includes(argument) && index + 1 < argumentsList.length) {
      const value = String(argumentsList[index + 1]);
      const key = value.slice(0, value.indexOf('=')).trim();
      if (CODEX_STABLE_MODEL_KEYS.has(key)) {
        index += 1;
        continue;
      }
    }
    result.push(argument);
  }
  return result;
}

export function hasStableCodexModelArguments(argumentsList = []) {
  const configured = Array.isArray(argumentsList) ? argumentsList : [];
  return configured.some((argument, start) => argument === CODEX_STABLE_MODEL_ARGUMENTS[0]
    && CODEX_STABLE_MODEL_ARGUMENTS.every((expected, offset) => configured[start + offset] === expected));
}

export function agentLaunchArguments(executable, argumentsList = []) {
  const configured = Array.isArray(argumentsList) ? argumentsList : [];
  const name = path.basename(String(executable || '')).toLowerCase();
  if (!name.includes('codex')) return [...configured];
  const base = configured.length > 0 ? configured : AUTONOMOUS_CODEX_ARGUMENTS;
  const cleaned = withoutOverriddenCodexConfig(base);
  const separator = cleaned.indexOf('--');
  if (separator < 0) return [...cleaned, ...CODEX_STABLE_MODEL_ARGUMENTS];
  return [...cleaned.slice(0, separator), ...CODEX_STABLE_MODEL_ARGUMENTS, ...cleaned.slice(separator)];
}
