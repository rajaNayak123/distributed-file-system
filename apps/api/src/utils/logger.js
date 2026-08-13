function log(level, message, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

const logger = {
  info: (message, fields) => log('info', message, fields),
  warn: (message, fields) => log('warn', message, fields),
  error: (message, fields) => log('error', message, fields),
  debug: (message, fields) => {
    if (process.env.LOG_LEVEL === 'debug') log('debug', message, fields);
  },
};

export default logger;
