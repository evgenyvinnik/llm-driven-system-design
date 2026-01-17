import winston from 'winston';

const { combine, timestamp, printf, colorize, align } = winston.format;

const logLevel = process.env.LOG_LEVEL || 'info';
const instanceId = process.env.INSTANCE_ID || '0';

const customFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [instance-${instanceId}] ${level}: ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: logLevel,
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), customFormat),
  transports: [
    new winston.transports.Console({
      format: combine(colorize({ all: true }), align(), customFormat),
    }),
  ],
});

export default logger;
