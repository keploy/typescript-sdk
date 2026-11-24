"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriceService = void 0;
// A NestJS-style service: class and method decorators.
function Injectable() {
    return (target) => target;
}
function Log() {
    return (_target, _key, desc) => desc;
}
let PriceService = class PriceService {
    constructor() {
        this.rate = 2;
    }
    quote(cents) {
        const total = cents * this.rate;
        return total;
    }
};
exports.PriceService = PriceService;
__decorate([
    Log()
], PriceService.prototype, "quote", null);
exports.PriceService = PriceService = __decorate([
    Injectable()
], PriceService);
//# sourceMappingURL=svc.js.map