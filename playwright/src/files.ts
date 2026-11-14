// The values a worker gives outside its tests (in a test.beforeAll) are its
// test file's. keploy holds them for each test the worker begins and for the
// worker's calls outside its tests, until this package ends them (POST
// /agent/scope/given with {"end": true}). Playwright runs a worker's files one
// after another, so the worker ends them as it moves on to another file:
// after that file's afterAll, before the next file's setup gives a value or
// its first test begins. Each file's values are then numbered alike however a
// run spreads its files over workers, and no test or setup of a later file
// carries an earlier file's value.

/** Which test file a worker is in, and whether keploy holds values it gave outside its tests. */
export class WorkerFiles {
  // The file the worker last began a test of or gave a value in; null
  // before either.
  private current: string | null = null;
  // keploy holds values the worker gave outside its tests.
  private holds = false;
  // The worker's move into current: the end of the values keploy held for
  // the earlier file, or nothing to wait for. Each caller in current waits
  // for this one promise, so a move sends one end however many callers enter
  // the file at once (two values a setup gives together).
  private moved: Promise<void> = Promise.resolve();

  /**
   * The worker works in file now (null: a place no test file is known for,
   * which leaves the file as it is). When keploy holds values the worker
   * gave in its earlier file, end ends them, once for the move, and every
   * caller in file waits for that end; it rejects for each of them when the
   * end is refused. A value given before the worker's first file is that
   * file's.
   */
  enter(file: string | null, end: () => Promise<void>): Promise<void> {
    if (file === null || file === this.current) return this.moved;
    const earlier = this.current;
    this.current = file;
    this.moved = this.holds && earlier !== null ? end().then(() => { this.holds = false; }) : Promise.resolve();
    return this.moved;
  }

  /** keploy holds a value the worker gave outside its tests. */
  gave(): void {
    this.holds = true;
  }
}
