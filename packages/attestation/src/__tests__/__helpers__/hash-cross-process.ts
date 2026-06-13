/**
 * Cross-process determinism helper. Reads a JSON envelope from stdin,
 * computes the hash, prints the bytes32 hex on stdout. Invoked via
 * child_process by the spawn-spawn-compare test in hash.test.ts.
 *
 * Kept minimal so any future divergence between fresh-Node and warm-Vitest
 * keccak implementations shows up cleanly.
 */
import { computeFeedbackHash } from '../../hash.ts';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
});
process.stdin.on('end', () => {
  try {
    const envelope = JSON.parse(buf);
    const hash = computeFeedbackHash(envelope);
    process.stdout.write(hash);
    process.exit(0);
  } catch (err) {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
});
