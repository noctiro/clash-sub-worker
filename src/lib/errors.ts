export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class UpstreamError extends Error {
  constructor(
    readonly status: 502 | 504,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}
