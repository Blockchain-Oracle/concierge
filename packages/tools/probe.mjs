import { z } from 'zod';

// 1) IsoDateTime {offset: true} acceptance matrix
const D = z.iso.datetime({ offset: true });
const cases = [
  ['Z', '2026-06-09T00:00:00Z'],
  ['+00:00', '2026-06-09T00:00:00+00:00'],
  ['+05:30', '2026-06-09T00:00:00+05:30'],
  ['naive', '2026-06-09T00:00:00'],
  ['ms + Z', '2026-06-09T00:00:00.123Z'],
  ['ms + offset', '2026-06-09T00:00:00.123+00:00'],
  ['date only', '2026-06-09'],
  ['epoch', '0'],
  ['unix-like', '1717891200'],
];
console.log('=== IsoDateTime ===');
for (const [label, val] of cases) {
  const r = D.safeParse(val);
  console.log(`  [${r.success ? 'OK ' : 'NO '}] ${label.padEnd(18)} "${val}"`);
}

// 2) z.toJSONSchema failure modes
console.log('\n=== toJSONSchema failure modes ===');
const probes = [
  ['refine', z.string().refine((s) => s.length > 0)],
  ['superRefine', z.string().superRefine(() => {})],
  ['transform', z.string().transform((s) => s.length)],
  ['pipe', z.string().pipe(z.number())],
  ['custom', z.custom((v) => typeof v === 'string')],
  [
    'recursive',
    (() => {
      const S = z.lazy(() => z.object({ next: S.optional() }));
      return S;
    })(),
  ],
  [
    'function',
    z.function ? (z.function && z.function().input ? z.function() : z.string()) : z.string(),
  ],
];
for (const [label, schema] of probes) {
  try {
    const j = z.toJSONSchema(schema, { target: 'openapi-3.0' });
    console.log(`  [OK  ] ${label.padEnd(14)} -> ${JSON.stringify(j).slice(0, 100)}`);
  } catch (e) {
    console.log(`  [THRW] ${label.padEnd(14)} -> ${e.message?.slice(0, 80) ?? e}`);
  }
}

// 3) createConciergeTools edge cases: Symbol-name, NaN, etc.
console.log('\n=== name-validation edge cases ===');
const sym = Symbol('x');
console.log(`  typeof Symbol('x')  = ${typeof sym}`); // symbol -> rejected (good)
// Object with toString returning string
const objName = { toString: () => 'fake' };
console.log(`  typeof objName      = ${typeof objName}`); // object -> rejected (good)
// What about explicit cast of Symbol — JSON.stringify would drop the name, but createConciergeTools checks `typeof t.name !== 'string'` → throws.

// 4) WeakSet circular-ref behavior on diamond non-circular access
console.log('\n=== WeakSet diamond (shared object via two paths) ===');
const shared = { v: 1 };
const root = { a: shared, b: shared };
try {
  const s = JSON.stringify(
    root,
    (() => {
      const seen = new WeakSet();
      return (_k, v) => {
        if (v !== null && typeof v === 'object') {
          if (seen.has(v)) throw new Error('false-positive circular');
          seen.add(v);
        }
        return v;
      };
    })(),
  );
  console.log(`  [OK ] diamond serialized: ${s}`);
} catch (e) {
  console.log(`  [BAD] diamond FAILED with seen-on-revisit: ${e.message}`);
}

// 5) Same diamond via bigintSafeStringify
console.log('\n=== bigintSafeStringify on diamond ===');
import('./src/bigintSafeStringify.ts')
  .then(({ bigintSafeStringify }) => {
    try {
      console.log('  ', bigintSafeStringify(root));
    } catch (e) {
      console.log('  THROW:', e.message);
    }
  })
  .catch((e) => console.log('  IMPORT FAIL:', e.message));
