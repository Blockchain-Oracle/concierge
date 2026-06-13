// Cross-process determinism helper. Invoked via `node` against the BUILT
// dist/ output — NOT tsx. Reading from a network-fetched tsx would let two
// children silently agree on the same wrong version, masking the very
// drift this test exists to catch.
import { computeFeedbackHash } from '../../../dist/index.js';

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
