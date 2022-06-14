export default new Proxy(
  {},
  {
    get(target, propertyKey, reciever) {
      //@ts-ignore
      const ctx = Zone.current.get("keployContext");
      if (!ctx) throw new Error("no context found!");

      if (propertyKey === "retrieve") {
        return () => ctx;
      }

      return Reflect.get(ctx, propertyKey, reciever);
    },
  }
);
