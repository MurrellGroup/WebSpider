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
  'check_for_update_on_startup=false',
  '-c',
  'tui.keymap.composer.submit=["enter","ctrl-enter"]',
  '-c',
  'tui.alternate_screen="never"',
]);

const CODEX_STABLE_MODEL_KEYS = new Set([
  'notice.hide_rate_limit_model_nudge',
  'check_for_update_on_startup',
  'tui.keymap.composer.submit',
  'tui.alternate_screen',
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

export function codexTrustedProjectArguments(argv, rootPath) {
  if (!Array.isArray(argv) || !argv.length || !path.basename(String(argv[0] || '')).toLowerCase().includes('codex')) {
    return Array.isArray(argv) ? [...argv] : [];
  }
  const canonical = path.resolve(String(rootPath || ''));
  const key = `projects.${JSON.stringify(canonical)}.trust_level`;
  const cleaned = [argv[0]];
  for (let index = 1; index < argv.length; index += 1) {
    const value = String(argv[index + 1] || '');
    if (['-c', '--config'].includes(argv[index]) && value.slice(0, value.indexOf('=')).trim() === key) {
      index += 1;
      continue;
    }
    cleaned.push(argv[index]);
  }
  const trust = ['-c', `${key}="trusted"`];
  const separator = cleaned.indexOf('--');
  if (separator < 0) return [...cleaned, ...trust];
  return [...cleaned.slice(0, separator), ...trust, ...cleaned.slice(separator)];
}

export function codexTrustedProjectConfig(contents, rootPath) {
  const canonical = path.resolve(String(rootPath || ''));
  const quoted = JSON.stringify(canonical);
  const table = `[projects.${quoted}]`;
  const dottedKey = `projects.${quoted}.trust_level`;
  const lines = String(contents || '').replace(/\r\n?/g, '\n').split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const equals = lines[index].indexOf('=');
    if (equals >= 0 && lines[index].slice(0, equals).trim() === dottedKey) {
      lines[index] = `${dottedKey} = "trusted"`;
      return `${lines.join('\n').replace(/\n*$/, '')}\n`;
    }
  }

  const tableIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === table || trimmed.startsWith(`${table} #`);
  });
  if (tableIndex >= 0) {
    let end = tableIndex + 1;
    while (end < lines.length && !/^\s*\[\[?/.test(lines[end])) end += 1;
    const trustIndex = lines.findIndex((line, index) => index > tableIndex && index < end
      && /^\s*trust_level\s*=/.test(line));
    if (trustIndex >= 0) lines[trustIndex] = 'trust_level = "trusted"';
    else lines.splice(tableIndex + 1, 0, 'trust_level = "trusted"');
    return `${lines.join('\n').replace(/\n*$/, '')}\n`;
  }

  const prefix = lines.join('\n').replace(/\n*$/, '');
  return `${prefix ? `${prefix}\n\n` : ''}${table}\ntrust_level = "trusted"\n`;
}
