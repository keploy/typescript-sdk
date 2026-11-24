// A NestJS-style service: class and method decorators.
function Injectable(): ClassDecorator {
  return (target) => target;
}

function Log(): MethodDecorator {
  return (_target, _key, desc) => desc;
}

@Injectable()
export class PriceService {
  private rate = 2;

  @Log()
  quote(cents: number): number {
    const total = cents * this.rate;
    return total;
  }
}
