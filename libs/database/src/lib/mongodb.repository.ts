import { Inject, type OnModuleInit, type Type } from '@nestjs/common';
import type { Connection, Model, QueryFilter, Types } from 'mongoose';
import {
  DatabaseError,
  DatabaseConflictError,
  DatabaseValidationError,
} from './database-error';
import { getEntityDefinition } from './entity';

export const REPOSITORY_CONNECTION = Symbol('MongoDBRepositoryConnection');
const registeredEntities = new WeakMap<Connection, Map<string, Type>>();

export interface MongoDBDatabase<T extends object> {
  readonly entity: Type<T>;
}

export type MongoDBDocument<T> = T & { _id: Types.ObjectId };
export interface MongoDBFindOptions {
  skip?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
}

/** Register subclasses through DatabaseModule.forFeature; no connection is created here. */
export abstract class MongoDBRepository<T extends object>
  implements MongoDBDatabase<T>, OnModuleInit
{
  abstract readonly entity: Type<T>;

  @Inject(REPOSITORY_CONNECTION)
  private readonly connection!: Connection;

  protected model!: Model<T>;

  // Optional manual model keeps standalone adapters/tests usable. Nest normally supplies the shared connection.
  constructor(model?: Model<T>) {
    if (model) this.model = model;
  }

  async onModuleInit(): Promise<void> {
    if (this.model && this.model.db !== this.connection) {
      throw new Error(
        'Repository model must use the registered shared connection',
      );
    }
    if (!this.model) {
      const { collection, schema } = getEntityDefinition(this.entity);
      let entities = registeredEntities.get(this.connection);
      if (!entities)
        registeredEntities.set(this.connection, (entities = new Map()));
      const existing = entities.get(collection);
      if (existing && existing !== this.entity) {
        throw new Error(
          'Conflicting entities registered for the same MongoDB collection',
        );
      }
      const cached = this.connection.models[collection] as Model<T> | undefined;
      if (
        cached &&
        (cached.schema !== schema ||
          cached.collection.collectionName !== collection)
      ) {
        throw new Error(
          'Conflicting model registered for the MongoDB collection',
        );
      }
      this.model =
        cached ?? this.connection.model<T>(collection, schema, collection);
      entities.set(collection, this.entity);
    }
    await this.execute(async () => {
      await this.model.init();
    });
  }

  protected async execute<R>(operation: () => Promise<R>): Promise<R> {
    try {
      return await operation();
    } catch (error) {
      const failure = error as { name?: string; code?: number };
      if (failure?.code === 11000) throw new DatabaseConflictError();
      if (
        failure?.name === 'ValidationError' ||
        failure?.name === 'CastError' ||
        error instanceof DatabaseValidationError
      ) {
        throw new DatabaseValidationError();
      }
      throw new DatabaseError();
    }
  }

  create(input: Partial<T>): Promise<MongoDBDocument<T>> {
    return this.execute(
      async () =>
        (await this.model.create(input)).toObject() as MongoDBDocument<T>,
    );
  }

  find(
    filter: QueryFilter<T> = {},
    options: MongoDBFindOptions = {},
  ): Promise<MongoDBDocument<T>[]> {
    return this.execute(async () => {
      if (
        (options.skip !== undefined &&
          (!Number.isSafeInteger(options.skip) || options.skip < 0)) ||
        (options.limit !== undefined &&
          (!Number.isSafeInteger(options.limit) || options.limit < 1))
      ) {
        throw new DatabaseValidationError();
      }
      return this.model
        .find(filter, null, options)
        .lean<MongoDBDocument<T>[]>()
        .exec();
    });
  }

  findOne(filter: QueryFilter<T>): Promise<MongoDBDocument<T> | null> {
    return this.execute(() =>
      this.model.findOne(filter).lean<MongoDBDocument<T> | null>().exec(),
    );
  }

  findById(id: string | Types.ObjectId): Promise<MongoDBDocument<T> | null> {
    return this.execute(() =>
      this.model.findById(id).lean<MongoDBDocument<T> | null>().exec(),
    );
  }

  updateById(
    id: string | Types.ObjectId,
    patch: Partial<T>,
  ): Promise<MongoDBDocument<T> | null> {
    return this.execute(() =>
      this.model
        .findByIdAndUpdate(
          id,
          { $set: patch },
          {
            returnDocument: 'after',
            runValidators: true,
            upsert: false,
          },
        )
        .lean<MongoDBDocument<T> | null>()
        .exec(),
    );
  }

  deleteById(id: string | Types.ObjectId): Promise<boolean> {
    return this.execute(
      async () =>
        (await this.model.deleteOne({ _id: id }).exec()).deletedCount === 1,
    );
  }

  count(filter: QueryFilter<T> = {}): Promise<number> {
    return this.execute(() => this.model.countDocuments(filter).exec());
  }
}
