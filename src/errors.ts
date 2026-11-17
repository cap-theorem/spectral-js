export type Op = "register" | "renew" | "lookup" | "status";

export class SpectralError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SidecarUnavailableError extends SpectralError {}

export class LeaseExpiredError extends SpectralError {}

export class APIError extends SpectralError {
  readonly op: Op;
  readonly status: number;
  readonly body: string;

  constructor(op: Op, status: number, body: string) {
    super(body === "" ? `spectral ${op}: http ${status}` : `spectral ${op}: http ${status}: ${body}`);
    this.op = op;
    this.status = status;
    this.body = body;
  }
}

export class InvalidRegistrationError extends APIError {}

export class AlreadyRegisteredError extends APIError {}

export class ServiceNotFoundError extends APIError {}

export class SidecarTimeoutError extends APIError {}

export function apiError(op: Op, status: number, body: string): SpectralError {
  if (status === 504) {
    return new SidecarTimeoutError(op, status, body);
  }
  if (op === "register" && status === 400) {
    return new InvalidRegistrationError(op, status, body);
  }
  if (op === "register" && status === 409) {
    return new AlreadyRegisteredError(op, status, body);
  }
  if (op === "lookup" && status === 404) {
    return new ServiceNotFoundError(op, status, body);
  }
  if (op === "renew" && status === 404) {
    const cause = new APIError(op, status, body);
    return new LeaseExpiredError(cause.message, { cause });
  }
  return new APIError(op, status, body);
}
