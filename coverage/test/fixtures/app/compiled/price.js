"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Cart = exports.discount = void 0;
exports.total = total;
function total(items) {
    let sum = 0;
    for (const it of items) {
        sum += it.cents;
    }
    return sum;
}
const discount = (cents, pct) => {
    if (pct <= 0) {
        return cents;
    }
    return Math.round((cents * (100 - pct)) / 100);
};
exports.discount = discount;
class Cart {
    constructor() {
        this.items = [];
    }
    add(item) {
        this.items.push(item);
    }
    get count() {
        return this.items.length;
    }
}
exports.Cart = Cart;
//# sourceMappingURL=price.js.map