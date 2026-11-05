// Simple structured logger for PayTrack backend
// In production, replace with Winston or Pino for log aggregation

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

function formatLog(level: LogLevel, message: string, meta?: Record<string, unknown>): LogEntry {
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    service: 'paytrack-backend',
    ...meta,
  };
}

function output(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const entry = formatLog(level, message, meta);
  const logString = JSON.stringify(entry);

  if (level === 'error') {
    console.error(logString);
  } else if (level === 'warn') {
    console.warn(logString);
  } else {
    console.log(logString);
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === 'debug') {
      output('debug', message, meta);
    }
  },
  info: (message: string, meta?: Record<string, unknown>) => {
    output('info', message, meta);
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    output('warn', message, meta);
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    output('error', message, meta);
  },
};
