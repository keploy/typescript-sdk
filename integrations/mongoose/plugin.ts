//@ts-nocheck

export default function keployMongoosePlugin(schema) {
  schema.post(["find", "findOne"], function (model, next) {
    const dependency = model;

    Zone.current
      .fork({ name: "requestContext", properties: { dependency } })
      .run(() => {
        next();
      });
  });
}
