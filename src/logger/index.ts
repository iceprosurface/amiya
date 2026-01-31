import winston from 'winston'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

export function setupLogger(directory: string) {
  const logDir = join(directory, 'logs')
  if (!existsSync(logDir)) {
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      // ignore
    }
  }

  return winston.createLogger({
    level: 'debug',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [
      new winston.transports.File({ filename: join(logDir, 'error.log'), level: 'error' }),
      new winston.transports.File({ filename: join(logDir, 'combined.log') }),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple(),
          winston.format.printf(({ level, message, timestamp }) => {
            return `${timestamp} [${level}]: ${message}`
          }),
        ),
      }),
    ],
  })
}

export const defaultLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
  transports: [new winston.transports.Console()],
})
