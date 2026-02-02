import { t } from "./i18n/index.js";

export class OpenCodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

export class DirectoryNotAccessibleError extends OpenCodeError {
  public readonly directory: string

  constructor(directory: string) {
    super(t("errors.dirAccess", { directory }))
    this.directory = directory
  }
}

export class ServerStartError extends OpenCodeError {
  public readonly port: number
  public readonly reason: string

  constructor(port: number, reason: string) {
    super(t("errors.serverStart", { port, reason }))
    this.port = port
    this.reason = reason
  }
}

export class ServerNotReadyError extends OpenCodeError {
  public readonly directory: string

  constructor(directory: string) {
    super(t("errors.serverNotReady", { directory }))
    this.directory = directory
  }
}

export class OpenCodeApiError extends OpenCodeError {
  public readonly status: number
  public readonly details: string

  constructor(status: number, details: string) {
    super(t("errors.apiError", { status, details }))
    this.status = status
    this.details = details
  }
}
