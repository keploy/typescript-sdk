// A suite's helper in a file of its own, as a suite's helpers file is: a
// suffix stamped with the time and a random number, made in the test
// process.
export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}
