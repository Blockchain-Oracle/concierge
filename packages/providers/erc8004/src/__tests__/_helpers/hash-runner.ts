// Spawned as a child process by the cross-process hash determinism test.
// Usage: node --experimental-strip-types hash-runner.ts '<jsonPayload>' <agentId> <chainId>
// Prints the feedbackHash to stdout (no newline).
import { hashActionPayload } from '../../eip712.ts';

const [, , payloadJson, agentIdStr, chainIdStr] = process.argv;
if (!payloadJson || !agentIdStr || !chainIdStr) {
  process.stderr.write('usage: hash-runner.ts <jsonPayload> <agentId> <chainId>\n');
  process.exit(1);
}

const payload = JSON.parse(payloadJson) as Record<string, unknown> & { schema: string };
const agentId = BigInt(agentIdStr);
const chainId = Number(chainIdStr) as 5000 | 5003;
process.stdout.write(hashActionPayload(payload, agentId, chainId));
