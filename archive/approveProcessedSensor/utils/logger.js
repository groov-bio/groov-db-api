export const logger = {
  debug: (message, data = {}) => {
    console.log(JSON.stringify({
      level: 'DEBUG',
      message,
      data,
      timestamp: new Date().toISOString()
    }));
  },
  info: (message, data = {}) => {
    console.log(JSON.stringify({
      level: 'INFO',
      message,
      data,
      timestamp: new Date().toISOString()
    }));
  },
  warn: (message, data = {}) => {
    console.log(JSON.stringify({
      level: 'WARN',
      message,
      data,
      timestamp: new Date().toISOString()
    }));
  },
  error: (message, error = {}, additionalData = {}) => {
    console.log(JSON.stringify({
      level: 'ERROR',
      message,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      additionalData,
      timestamp: new Date().toISOString()
    }));
  }
};
