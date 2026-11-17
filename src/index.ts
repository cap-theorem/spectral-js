export {
  ADDR_ENV,
  DEFAULT_ADDR,
  SpectralClient,
  VERSION,
  type CallOptions,
  type ClientOptions,
  type Lease,
  type Provider,
  type Registration,
  type State,
  type Status,
} from "./client.ts";
export {
  APIError,
  AlreadyRegisteredError,
  InvalidRegistrationError,
  LeaseExpiredError,
  ServiceNotFoundError,
  SidecarTimeoutError,
  SidecarUnavailableError,
  SpectralError,
  type Op,
} from "./errors.ts";
