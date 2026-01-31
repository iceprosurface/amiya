export class OpenCodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
  }
}

export class DirectoryNotAccessibleError extends OpenCodeError {
  public readonly directory: string

  constructor(directory: string) {
    super(`目录无法访问：${directory}`)
    this.directory = directory
  }
}

export class ServerStartError extends OpenCodeError {
  public readonly port: number
  public readonly reason: string

  constructor(port: number, reason: string) {
    super(`OpenCode 服务器在端口 ${port} 启动失败：${reason}`)
    this.port = port
    this.reason = reason
  }
}

export class ServerNotReadyError extends OpenCodeError {
  public readonly directory: string

  constructor(directory: string) {
    super(`OpenCode 服务器尚未准备好用于目录：${directory}`)
    this.directory = directory
  }
}

export class OpenCodeApiError extends OpenCodeError {
  public readonly status: number
  public readonly details: string

  constructor(status: number, details: string) {
    super(`OpenCode API 错误 (${status})：${details}`)
    this.status = status
    this.details = details
  }
}
