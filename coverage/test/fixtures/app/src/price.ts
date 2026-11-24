// Prices, in cents.
export interface Item {
  sku: string;
  cents: number;
}

export function total(items: Item[]): number {
  let sum = 0;
  for (const it of items) {
    sum += it.cents;
  }
  return sum;
}

export const discount = (cents: number, pct: number): number => {
  if (pct <= 0) {
    return cents;
  }
  return Math.round((cents * (100 - pct)) / 100);
};

export class Cart {
  private items: Item[] = [];

  add(item: Item): void {
    this.items.push(item);
  }

  get count(): number {
    return this.items.length;
  }
}
