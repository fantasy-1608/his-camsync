/**
 * HIS CamSync - Lightweight E2E Test Framework
 * Provides a clean describe/test/assert API for Tier 1-4 suites
 * with zero external testing framework dependencies.
 */

import assert from 'node:assert';

export class TestRunnerContext {
  constructor() {
    this.suites = [];
    this.currentSuite = null;
    this.stats = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      startTime: 0,
      endTime: 0
    };
  }

  describe(name, fn) {
    const parentSuite = this.currentSuite;
    const suite = {
      name,
      tests: [],
      beforeAll: [],
      afterAll: [],
      beforeEach: [],
      afterEach: [],
      parent: parentSuite
    };

    if (parentSuite) {
      parentSuite.suites = parentSuite.suites || [];
      parentSuite.suites.push(suite);
    } else {
      this.suites.push(suite);
    }

    this.currentSuite = suite;
    try {
      fn();
    } finally {
      this.currentSuite = parentSuite;
    }
  }

  test(name, fn) {
    if (!this.currentSuite) {
      this.describe('Default Suite', () => {
        this.test(name, fn);
      });
      return;
    }
    this.currentSuite.tests.push({ name, fn, status: 'pending', error: null, duration: 0 });
  }

  beforeAll(fn) {
    if (this.currentSuite) this.currentSuite.beforeAll.push(fn);
  }

  afterAll(fn) {
    if (this.currentSuite) this.currentSuite.afterAll.push(fn);
  }

  beforeEach(fn) {
    if (this.currentSuite) this.currentSuite.beforeEach.push(fn);
  }

  afterEach(fn) {
    if (this.currentSuite) this.currentSuite.afterEach.push(fn);
  }

  async runSuite(suite, indent = 0) {
    const pad = '  '.repeat(indent);
    console.log(`\n${pad}\x1b[1m\x1b[36m▶ Suite: ${suite.name}\x1b[0m`);

    // Run beforeAll
    for (const hook of suite.beforeAll) {
      await hook();
    }

    // Run tests in this suite
    for (const t of suite.tests) {
      this.stats.total++;
      const tStart = performance.now();

      // Collect all beforeEach hooks from ancestor suites to this suite
      const beforeEachHooks = [];
      let s = suite;
      while (s) {
        if (s.beforeEach) beforeEachHooks.unshift(...s.beforeEach);
        s = s.parent;
      }
      for (const hook of beforeEachHooks) {
        await hook();
      }

      try {
        await t.fn();
        t.status = 'passed';
        t.duration = performance.now() - tStart;
        this.stats.passed++;
        console.log(`${pad}  \x1b[32m✔\x1b[0m ${t.name} \x1b[90m(${t.duration.toFixed(1)}ms)\x1b[0m`);
      } catch (err) {
        t.status = 'failed';
        t.error = err;
        t.duration = performance.now() - tStart;
        this.stats.failed++;
        console.error(`${pad}  \x1b[31m✖\x1b[0m ${t.name} \x1b[90m(${t.duration.toFixed(1)}ms)\x1b[0m`);
        console.error(`${pad}    \x1b[31mError: ${err.message}\x1b[0m`);
        if (err.stack) {
          const stackLines = err.stack.split('\n').slice(1, 4).map(l => `${pad}    ${l}`).join('\n');
          console.error(`\x1b[90m${stackLines}\x1b[0m`);
        }
      }

      // Collect all afterEach hooks
      const afterEachHooks = [];
      s = suite;
      while (s) {
        if (s.afterEach) afterEachHooks.push(...s.afterEach);
        s = s.parent;
      }
      for (const hook of afterEachHooks) {
        try {
          await hook();
        } catch (hookErr) {
          console.error(`${pad}  \x1b[31mError in afterEach hook: ${hookErr.message}\x1b[0m`);
        }
      }
    }

    // Run child suites
    if (suite.suites) {
      for (const childSuite of suite.suites) {
        await this.runSuite(childSuite, indent + 1);
      }
    }

    // Run afterAll
    for (const hook of suite.afterAll) {
      try {
        await hook();
      } catch (hookErr) {
        console.error(`${pad}  \x1b[31mError in afterAll hook: ${hookErr.message}\x1b[0m`);
      }
    }
  }

  async run() {
    this.stats.startTime = performance.now();
    for (const suite of this.suites) {
      await this.runSuite(suite, 0);
    }
    this.stats.endTime = performance.now();
    const duration = ((this.stats.endTime - this.stats.startTime) / 1000).toFixed(2);

    console.log('\n' + '─'.repeat(70));
    console.log(`\x1b[1mExecution Summary:\x1b[0m`);
    console.log(`  Total:  \x1b[1m${this.stats.total}\x1b[0m`);
    console.log(`  Passed: \x1b[32m${this.stats.passed}\x1b[0m`);
    console.log(`  Failed: ${this.stats.failed > 0 ? `\x1b[31m${this.stats.failed}\x1b[0m` : '\x1b[32m0\x1b[0m'}`);
    console.log(`  Duration: ${duration}s`);
    console.log('─'.repeat(70) + '\n');

    return this.stats;
  }
}

// Global runner instance for simple imports
export const globalContext = new TestRunnerContext();

export function describe(name, fn) {
  globalContext.describe(name, fn);
}

export function test(name, fn) {
  globalContext.test(name, fn);
}

export const it = test;

export function beforeAll(fn) {
  globalContext.beforeAll(fn);
}

export function afterAll(fn) {
  globalContext.afterAll(fn);
}

export function beforeEach(fn) {
  globalContext.beforeEach(fn);
}

export function afterEach(fn) {
  globalContext.afterEach(fn);
}

// Custom assertions extended with domain-specific helpers
export const expect = {
  equal: assert.strictEqual,
  deepEqual: assert.deepStrictEqual,
  ok: assert.ok,
  match: assert.match,
  doesNotMatch: assert.doesNotMatch,
  rejects: assert.rejects,
  throws: assert.throws,
  closeTo(actual, expected, delta, message) {
    if (Math.abs(actual - expected) > delta) {
      assert.fail(message || `Expected ${actual} to be close to ${expected} within delta ${delta}`);
    }
  }
};

export { assert };
