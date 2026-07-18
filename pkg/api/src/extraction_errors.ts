// name is set so it survives into a job's stored error object (toJobError
// records error.name), letting the scorecard routes distinguish a read
// failure from a generic service error.
export class RateLimitError extends Error {
  override name = "RateLimitError";
}
export class ScorecardReadError extends Error {
  override name = "ScorecardReadError";
}
