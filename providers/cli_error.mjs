// Classify a non-zero CLI-provider exit by its stderr.
//
// claude-cli / codex-cli / gemini-cli all surface upstream throttling by
// exiting non-zero with the throttle text on stderr — e.g. claude's
// "Server temporarily limiting requests (not your usage limit)", an
// overloaded_error, or a bare HTTP 429/5xx. Those are transient: the same
// call usually succeeds shortly, so they should map to a RETRIABLE error code
// (RATE_LIMIT) that withRateLimitRetry retries before the first chunk.
//
// A genuine, durable cap — a subscription usage limit, out of credits, quota
// exceeded — must NOT be retried: retrying just burns the same wall and fails
// again, so it keeps the non-retriable CLI_EXIT code and surfaces fast.
//
// Subtlety: the transient throttle text literally contains the words "usage
// limit" ("...not your usage limit..."), so the durable-cap pattern is phrased
// to require the "reached"/"exceeded"/"out of" wording a real cap uses — it
// must not fire on the transient throttle.

// Durable caps — never retry. Each alternative carries the cap-specific
// wording so the bare phrase "usage limit" inside the transient text can't
// match.
const DURABLE_CAP = /usage limit reached|reached your (?:usage|plan|monthly|account|daily) limit|out of credits|quota (?:has been )?exceeded|insufficient (?:\w+ )?credits?|please upgrade|upgrade your plan/i;

// Transient throttle / overload — retry after a short pause.
const TRANSIENT = /temporarily limiting|limiting requests|overloaded|rate.?limited?|too many requests|\b(?:429|500|502|503|504|529)\b|please try again|service unavailable/i;

const DEFAULT_CLI_RETRY_AFTER_MS = 3000;

/**
 * @param {unknown} stderr  Captured stderr from the failed CLI invocation.
 * @returns {{ code: 'RATE_LIMIT' | 'CLI_EXIT', retriable: boolean, retryAfterMs?: number }}
 */
export function classifyCliExit(stderr) {
  const s = String(stderr ?? '');
  if (DURABLE_CAP.test(s)) return { code: 'CLI_EXIT', retriable: false };
  if (TRANSIENT.test(s)) return { code: 'RATE_LIMIT', retriable: true, retryAfterMs: DEFAULT_CLI_RETRY_AFTER_MS };
  return { code: 'CLI_EXIT', retriable: false };
}
