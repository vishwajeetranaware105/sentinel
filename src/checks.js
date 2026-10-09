/**
 * The review check catalogue. Each check is a focused lens the model must apply to every hunk.
 * Users toggle them in the UI; profiles add repo-specific gates on top.
 */
export const CHECKS = [
  {
    id: 'bugs', label: 'Bugs & logic errors', default: true, kind: 'bug',
    prompt: 'Logic errors, off-by-one, wrong conditions, inverted checks, null/undefined/None dereference, unhandled error paths, wrong types, copy-paste mistakes, dead branches, state that is set but never reset, resource leaks.',
  },
  {
    id: 'breaking', label: 'Breaking changes', default: true, kind: 'breaking',
    prompt: 'Changed or removed public signatures, renamed fields/keys/enums, changed serialized/wire formats, changed defaults, DB/schema migrations, config key changes, behaviour changes that existing callers or older clients rely on. Check callers outside the diff exist before claiming a break.',
  },
  {
    id: 'security', label: 'Security', default: true, kind: 'bug',
    prompt: 'Injection, authz/authn gaps, trusting client input, secrets or PII in code or logs, unsafe deserialization, weak crypto, missing validation, replay, TOCTOU, SSRF/path traversal.',
  },
  {
    id: 'concurrency', label: 'Concurrency & lifecycle', default: true, kind: 'bug',
    prompt: 'Races, shared mutable state without locks, non-atomic check-then-act, callbacks after teardown, main-thread blocking, lifecycle/ordering assumptions, missing cleanup.',
  },
  {
    id: 'errors', label: 'Error handling & edge cases', default: true, kind: 'bug',
    prompt: 'Empty/huge/malformed input, network and timeout failure, partial failure, swallowed exceptions, unwrap/force-unwrap/panic on external data, missing fallbacks, retries without limits.',
  },
  {
    id: 'compat', label: 'Compatibility & rollout', default: true, kind: 'breaking',
    prompt: 'Producer/consumer ordering (does the consumer ship before the producer?), old-client vs new-server behaviour, feature flags, backward-compatible defaults, versioning.',
  },
  {
    id: 'tests', label: 'Test coverage', default: false, kind: 'suggestion',
    prompt: 'Behaviour changes without a test, tests that do not assert anything meaningful, missing regression test for a fixed bug. Only flag when a test is clearly missing for risky logic.',
  },
  {
    id: 'perf', label: 'Performance', default: false, kind: 'suggestion',
    prompt: 'N+1 calls, work in hot paths or loops, unbounded growth, needless allocation/copies, blocking IO on latency-sensitive paths.',
  },
  {
    id: 'quality', label: 'Readability & maintainability', default: false, kind: 'suggestion',
    prompt: 'Naming, duplication, dead code, misleading comments, overly complex functions, magic numbers. Keep to things that will actually bite a maintainer.',
  },
];

/** Repo-specific gates. Matched on the repository slug. */
export const PROFILES = [
  {
    id: 'rasp-kavach',
    match: /hyper-rasp|kavach/i,
    label: 'HyperRASP / Kavach security gates',
    prompt: `This repo is part of the HyperRASP / Kavach security stack. Every change must pass four gates; a failing gate is a blocker:
1. NO CRASHES: no new way to crash/SIGSEGV/SIGABRT/panic on any reachable path. Native: no raw memcmp/strcmp/strncmp on dladdr/dlopen/path/string pointers (use byte-by-byte volatile reads), bounds-check every new index/pointer (no len-1 underflow on empty input), every GetStringUTFChars needs Release, no use-after-free of JNI refs. Rust: no unwrap/expect/panic!/array-index/unreachable! on client-shaped data; use ? and typed errors. Migrations must create columns before queries read them.
2. NO FALSE POSITIVES: a clean device must never be marked compromised. For any new detection bit enumerate the exact input that sets it and ask if stock Android / dev options / user CA certs / OEM packages / poor network can hit it. Transport or validation errors must short-circuit BEFORE crypto/tamper enforcement. Merely suspicious signals must be WARN, never block/forced-exit. Bit-to-code maps must match across HyperRasp.kt bitToCode, server_rules.cpp K_BIT_TO_VULN and defaults.rs.
3. NO SECURITY REDUCTION: nothing may remove, weaken, or make advisory an existing detection/attestation/enforcement control. Raw-syscall wrappers must not be replaced by libc calls. Fail-closed behaviour (missing derived key => 401, nonce replay => 401) must stay. Lengthening grace windows or NONCE_TTL is suspect. Silent stubs that always return 0 disable checks.
4. NO HACKER LOOPHOLES: re-init must not reset channelAesKey/session/bitmask without re-attest; server must never trust a client-supplied clean claim; session.attested may only be true on a CLEAN attestation verdict; an unattested session must escalate, never stay pending forever; admin routes must be admin-key gated.
Cross-repo: envelope layout/magic/HMAC region/KDF salt must agree between SDK and server; the server must not consume a field the shipped SDK does not yet send.
Tag findings from these gates with the gate name in "category" (gate_crash, gate_false_pos, gate_no_decrease, gate_loophole, cross_repo) and mark them severity "blocker".`,
  },
];

export function profileFor(repo) {
  return PROFILES.find((p) => p.match.test(repo)) || null;
}
