// daemon/lib/learn_queue.mjs — bounded, serialised runner for the /inbound
// post-task learning hook.
//
// runLearning fires up to two trainer LLM completions (skill synthesis + the
// user model) and, with trainer 'auto', may spawn a claude-cli subprocess —
// per call, with no throttle of its own. A channel message burst hitting
// POST /inbound must not fan that out unbounded, so learning jobs run one at
// a time and the waiting line is capped: when it is full the newest job is
// DROPPED (learning is best-effort; the trajectory of a dropped turn is
// simply not recorded — the next turn learns again).

const MAX_DEPTH = 8;

let _running = false;
const _waiting = [];
let _dropped = 0;

function _drain() {
  if (_running) return;
  const job = _waiting.shift();
  if (!job) return;
  _running = true;
  Promise.resolve()
    .then(job)
    .catch(() => { /* learning is best-effort */ })
    .finally(() => { _running = false; _drain(); });
}

// Enqueue a learning job (a function returning a promise). Returns true when
// accepted, false when the queue was full and the job was dropped.
export function enqueueLearning(job) {
  if (_waiting.length >= MAX_DEPTH) {
    _dropped++;
    if (_dropped === 1 || _dropped % 50 === 0) {
      process.stderr.write(`[learn] queue full — dropped ${_dropped} learning job(s) so far (burst protection)\n`);
    }
    return false;
  }
  _waiting.push(job);
  _drain();
  return true;
}

// Test hooks.
export function _learnQueueStats() { return { running: _running, waiting: _waiting.length, dropped: _dropped }; }
export function _resetLearnQueue() { _waiting.length = 0; _running = false; _dropped = 0; }
