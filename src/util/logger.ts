/* Minimal structured logger with levels and optional scoping. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

let minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const tag = scope ? `[${scope}]` : '';
  const line = `${COLORS[level]}${ts()} ${level.toUpperCase().padEnd(5)}${RESET} ${tag} ${msg}`;
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.log(line, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope = ''): Logger {
  return {
    debug: (msg, extra) => emit('debug', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    error: (msg, extra) => emit('error', scope, msg, extra),
    child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

export const log = createLogger();
