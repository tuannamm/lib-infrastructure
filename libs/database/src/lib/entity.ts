import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import type { Schema, SchemaOptions } from 'mongoose';

const ENTITY = Symbol('MongoDBEntity');
const schemas = new WeakMap<Type, Schema>();

export interface EntityOptions extends Omit<SchemaOptions, 'collection'> {
  collection: string;
}

/** Collection names are explicit; Mongoose pluralization is never used. */
export function Entity(options: EntityOptions): ClassDecorator {
  if (
    !options.collection?.trim() ||
    options.collection.includes('\0') ||
    options.collection.startsWith('system.')
  ) {
    throw new Error('Invalid entity collection');
  }
  return (target) => {
    const resolved = { bufferCommands: false, ...options };
    Reflect.defineMetadata(ENTITY, resolved, target);
    MongooseSchema(resolved)(target);
  };
}

export function getEntityDefinition<T>(entity: Type<T>) {
  const options = Reflect.getOwnMetadata(ENTITY, entity) as
    EntityOptions | undefined;
  if (!options)
    throw new Error('Repository entity must have an @Entity decorator');
  let schema = schemas.get(entity);
  if (!schema) {
    schema = SchemaFactory.createForClass(entity);
    schemas.set(entity, schema);
  }
  return { collection: options.collection, schema: schema as Schema<T> };
}

export { Prop as Field } from '@nestjs/mongoose';
