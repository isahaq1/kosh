/**
 * The flaky-test ledger (RFC 0034 step 1). Vitest retries a failed test once (`retry: 1`); a test that fails and
 * then passes is **flaky**, not green. This reporter names every flaky test at the end of the run, and keeps a
 * ledger of strikes per test (`.flaky-ledger.json`, cached between CI runs): a test reaching three strikes fails
 * the run until it is fixed. A run where the test passes the first time clears its strikes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

const LEDGER = '.flaky-ledger.json';
const STRIKES = 3;

type Ledger = Record<string, { strikes: number; last: string }>;

export default class FlakyReporter implements Reporter {
  readonly #flaky: string[] = [];
  readonly #clean: string[] = [];

  onTestCaseResult(testCase: TestCase): void {
    const id = `${testCase.module.relativeModuleId} > ${testCase.fullName}`;
    const result = testCase.result();
    if (result.state !== 'passed') return;
    if (testCase.diagnostic()?.flaky === true) this.#flaky.push(id);
    else this.#clean.push(id);
  }

  onTestRunEnd(_modules: ReadonlyArray<TestModule>): void {
    let ledger: Ledger = {};
    try {
      if (existsSync(LEDGER)) ledger = JSON.parse(readFileSync(LEDGER, 'utf8')) as Ledger;
    } catch {
      ledger = {};
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const id of this.#clean) delete ledger[id];
    for (const id of this.#flaky)
      ledger[id] = { strikes: (ledger[id]?.strikes ?? 0) + 1, last: today };
    writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);

    if (this.#flaky.length === 0) return;
    const out = [
      '',
      `Flaky: ${this.#flaky.length} test(s) failed, then passed on retry (strikes in ${LEDGER}):`,
      ...this.#flaky.map((id) => `  ${ledger[id]?.strikes ?? 1}/${STRIKES}  ${id}`),
    ];
    const out3 = this.#flaky.filter((id) => (ledger[id]?.strikes ?? 0) >= STRIKES);
    if (out3.length > 0) {
      out.push(
        '',
        `${out3.length} test(s) reached ${STRIKES} strikes: fix them (the run fails until then).`,
      );
      process.exitCode = 1;
    }
    process.stdout.write(`${out.join('\n')}\n`);
  }
}
