/**
 * Converts all of the keys of an existing object from camelCase to snake_case.
 * @param obj Any object, ideally with camelCase keys.
 * @returns A new object, with camelCase keys replaced with snake_case keys.
 */
const transformToSnakeCase = (obj: any): object => {
  const snakeCaseObj: any = {};

  for (const key of Object.keys(obj)) {
    const snakeCaseKey = key.replace(
      /[A-Z]/g,
      (char) => `_${char.toLowerCase()}`
    );
    snakeCaseObj[snakeCaseKey] = obj[key];
  }
  return snakeCaseObj;
};

export { transformToSnakeCase };
