import { kDeleteMany, kDeleteOne } from "./delete";
import { kFind, kFindOne } from "./find";
import { kInsertMany, kInsertOne } from "./insert";
import { kUpdateMany, kUpdateOne } from "./update";
// import { collection } from "./require";

export class Collection1 {
  // deleteOne method function for mocked mongo connection
  // @ts-ignore
  deleteOne(...args) {
    // calls the wrapper with this object binded
    kDeleteOne.apply(this, args);
  }

  // deleteMany method function for mocked mongo connection
  // @ts-ignore
  deleteMany(...args) {
    // calls the wrapper with this object binded
    kDeleteMany.apply(this, args);
  }

  // updateOne method function for mocked mongo connection
  // @ts-ignore
  updateOne(...args) {
    // calls the wrapper with this object binded
    kUpdateOne.apply(this, args);
  }

  // updateMany method function for mocked mongo connection
  // @ts-ignore
  updateMany(...args) {
    // calls the wrapper with this object binded
    kUpdateMany.apply(this, args);
  }

  // insertOne method function for mocked mongo connection
  // @ts-ignore
  insertOne(...args) {
    // calls the wrapper with this object binded
    kInsertOne.apply(this, args);
  }

  // insertMany method function for mocked mongo connection
  // @ts-ignore
  insertMany(...args) {
    // calls the wrapper with this object binded
    kInsertMany.apply(this, args);
  }

  // findOne method function for mocked mongo connection
  // @ts-ignore
  findOne(...args) {
    // calls the wrapper with this object binded
    kFindOne.apply(this, args);
  }

  // find method function for mocked mongo connection
  // @ts-ignore
  find(...args) {
    // calls the wrapper with this object binded
    kFind.apply(this, args);
  }
}
