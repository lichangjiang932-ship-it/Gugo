import { normalizeMutationTarget } from './heuristics/mutationClassification.js'

const SHA256 = /^[a-f0-9]{64}$/u

/**
 * What a read-back must find for a write to count as verified.
 *
 * A write tool reports the digest of the bytes it wrote. A read-back used to
 * clear the file's debt by path alone, so a write that "succeeded" but left the
 * file truncated, empty or replaced by something else was verified by any read.
 * When the write reported its digest, the read-back must report the same one.
 * A mutation that reports none (a script, a patch) keeps the path rule: there is
 * no intent to compare against, and a later write of the file replaces the
 * expectation rather than adding to it.
 */
export function createMutationContentBinding(restored = {}) {
  const expected = new Map(Object.entries(restored && typeof restored === 'object' ? restored : {})
    .map(([target, digest]) => [normalizeMutationTarget(target), String(digest || '')])
    .filter(([target, digest]) => target && SHA256.test(digest)))

  return Object.freeze({
    /** Called for every target a successful mutation produced. */
    observe(targets, result) {
      const digest = String(result?.sha256 || '')
      const single = [...targets].length === 1
      for (const target of targets) {
        // A digest describes one file; a call that wrote several says nothing per file.
        if (single && SHA256.test(digest)) expected.set(target, digest)
        else expected.delete(target)
      }
    },
    /** Whether this read-back result matches the bytes the write intended. */
    readMatches(target, result) {
      const want = expected.get(normalizeMutationTarget(target))
      if (!want) return true
      return String(result?.sha256 || '') === want
    },
    /** The digest a pending target is waiting for, if its write reported one. */
    expectedDigest(target) {
      return expected.get(normalizeMutationTarget(target)) || null
    },
    forget(target) {
      expected.delete(normalizeMutationTarget(target))
    },
    serialize() {
      return Object.fromEntries(expected)
    },
  })
}
