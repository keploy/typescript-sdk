// The values a worker gives outside its tests (in a test.beforeAll) are its
// test file's. keploy holds them for each test the worker begins, until this
// package ends them (POST /agent/scope/given with {"end": true}). Playwright
// runs a worker's files one after another, so the worker ends them as it
// moves on to another file: after that file's afterAll, before the next
// file's setup gives a value or its first test begins. Each file's values are
// then numbered alike however a run spreads its files over workers, and no
// test of a later file carries an earlier file's value.

/** Which test file a worker is in, and whether keploy holds values it gave outside its tests. */
export class WorkerFiles {
  // The file the worker last began a test of or gave a value in; null
  // before either.
  private current: string | null = null;
  // keploy holds values the worker gave outside its tests.
  private holds = false;

  /**
   * Whether the values keploy holds must end before the worker works in
   * file (null: a place no test file is known for, which leaves the file as
   * it is). A value given before the worker's first file is that file's.
   */
  mustEnd(file: string | null): boolean {
    return this.holds && this.current !== null && file !== null && file !== this.current;
  }

  /** The worker works in file now (null: as before). */
  entered(file: string | null): void {
    if (file !== null) this.current = file;
  }

  /** keploy holds a value the worker gave outside its tests. */
  gave(): void {
    this.holds = true;
  }

  /** keploy dropped the worker's values. */
  ended(): void {
    this.holds = false;
  }
}
