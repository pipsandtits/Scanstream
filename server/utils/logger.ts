import fs from 'fs';
import path from 'path';

// Configuration
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per chunk
const MAX_LOGS_TO_KEEP = 20; // Keep last 20 chunks per session

// Create logs directory with session subdirectory
const logsDir = path.join(process.cwd(), 'logs');
const sessionId = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + Date.now();
const sessionLogsDir = path.join(logsDir, sessionId);

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

if (!fs.existsSync(sessionLogsDir)) {
  fs.mkdirSync(sessionLogsDir, { recursive: true });
}

// Track current chunk number
let currentChunk = 0;
let currentFileSize = 0;

// Get log file path with chunk number
const getLogFilePath = (chunkNum: number) => {
  const date = new Date().toISOString().split('T')[0];
  return path.join(sessionLogsDir, `server-${date}-chunk-${chunkNum.toString().padStart(3, '0')}.log`);
};

// Write stream for logs
let writeStream: fs.WriteStream | null = null;

// Cleanup old chunks, keeping only MAX_LOGS_TO_KEEP most recent
const cleanupOldChunks = () => {
  try {
    const files = fs.readdirSync(sessionLogsDir)
      .filter(f => f.endsWith('.log'))
      .sort()
      .reverse();
    
    if (files.length > MAX_LOGS_TO_KEEP) {
      for (let i = MAX_LOGS_TO_KEEP; i < files.length; i++) {
        const filePath = path.join(sessionLogsDir, files[i]);
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    console.error('Error cleaning up old chunks:', err);
  }
};

// Rotate to next chunk when file reaches size limit
const rotateLogFile = () => {
  if (writeStream) {
    writeStream.end();
    writeStream = null;
  }
  currentChunk++;
  currentFileSize = 0;
  cleanupOldChunks();
};

const getWriteStream = () => {
  const currentPath = getLogFilePath(currentChunk);
  
  // Check if file exists and its size
  if (fs.existsSync(currentPath)) {
    currentFileSize = fs.statSync(currentPath).size;
  }
  
  // Rotate if file exceeds max size
  if (currentFileSize >= MAX_LOG_FILE_SIZE) {
    rotateLogFile();
  }
  
  if (!writeStream) {
    writeStream = fs.createWriteStream(getLogFilePath(currentChunk), { flags: 'a' });
  }
  
  return writeStream;
};

/**
 * Log messages to both console and file with automatic chunking
 */
export function logToFile(level: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level}] ${message}${data ? '\n  ' + JSON.stringify(data) : ''}`;
  
  // Write to file
  try {
    const stream = getWriteStream();
    stream.write(logEntry + '\n');
    currentFileSize += logEntry.length + 1;
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
}

/**
 * Intercept console.log/error/warn to write to file
 */
export function setupConsoleLogging() {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const serializeArg = (a: any) => {
    if (a instanceof Error) {
      return `${a.message}\n${a.stack}`;
    }
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  };

  console.log = (...args: any[]) => {
    const message = args.map(serializeArg).join(' ');
    logToFile('INFO', message);
    originalLog(...args);
  };

  console.error = (...args: any[]) => {
    const message = args.map(serializeArg).join(' ');
    logToFile('ERROR', message);
    originalError(...args);
  };

  console.warn = (...args: any[]) => {
    const message = args.map(serializeArg).join(' ');
    logToFile('WARN', message);
    originalWarn(...args);
  };
}

/**
 * Normalize unknown errors into a serializable object with message and optional stack
 */
export function formatError(e: unknown) {
  const message = e instanceof Error
    ? e.message
    : typeof e === 'string'
      ? e
      : (() => { try { return JSON.stringify(e); } catch { return String(e); } })() || 'unknown error';

  return {
    message,
    stack: e instanceof Error ? e.stack : undefined
  } as { message: string; stack?: string };
}

/**
 * Get path to current log session directory
 */
export function getLogPath() {
  return sessionLogsDir;
}

/**
 * Get current log session ID
 */
export function getSessionId() {
  return sessionId;
}

/**
 * Get path to current log chunk file
 */
export function getCurrentLogFile() {
  return getLogFilePath(currentChunk);
}

/**
 * Get all log files in current session
 */
export function getSessionLogFiles() {
  try {
    return fs.readdirSync(sessionLogsDir)
      .filter(f => f.endsWith('.log'))
      .map(f => path.join(sessionLogsDir, f))
      .sort();
  } catch (err) {
    return [];
  }
}

/**
 * Get log statistics
 */
export function getLogStats() {
  try {
    const files = getSessionLogFiles();
    const stats = files.map(f => {
      const stat = fs.statSync(f);
      return {
        file: path.basename(f),
        size: stat.size,
        created: stat.birthtime,
      };
    });
    
    return {
      sessionId,
      sessionDir: sessionLogsDir,
      totalChunks: files.length,
      totalSize: stats.reduce((sum, s) => sum + s.size, 0),
      chunks: stats,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Close the write stream gracefully
 */
export function closeLogger() {
  if (writeStream) {
    writeStream.end();
    writeStream = null;
  }
}

/**
 * Get a logger instance for a specific module/component
 * Automatically prefixes messages with module name
 */
export class ModuleLogger {
  constructor(private moduleName: string) {}
  
  info(message: string, data?: any) {
    const payload = data instanceof Error ? { message: data.message, stack: data.stack } : data;
    console.log(`[${this.moduleName}] ${message}`, payload);
    logToFile('INFO', `[${this.moduleName}] ${message}`, payload);
  }
  
  error(message: string, data?: any) {
    const payload = data instanceof Error ? { message: data.message, stack: data.stack } : data;
    console.error(`[${this.moduleName}] ❌ ${message}`, payload);
    logToFile('ERROR', `[${this.moduleName}] ${message}`, payload);
  }
  
  warn(message: string, data?: any) {
    const payload = data instanceof Error ? { message: data.message, stack: data.stack } : data;
    console.warn(`[${this.moduleName}] ⚠️ ${message}`, payload);
    logToFile('WARN', `[${this.moduleName}] ${message}`, payload);
  }
  
  debug(message: string, data?: any) {
    if (process.env.DEBUG) {
      const payload = data instanceof Error ? { message: data.message, stack: data.stack } : data;
      console.log(`[${this.moduleName}] 🔍 ${message}`, payload);
      logToFile('DEBUG', `[${this.moduleName}] ${message}`, payload);
    }
  }
}
