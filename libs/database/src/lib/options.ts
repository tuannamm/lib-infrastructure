import type { ModuleMetadata } from '@nestjs/common';
import type { MongooseModuleOptions } from '@nestjs/mongoose';
import type { ConnectOptions } from 'mongoose';
import { mongo } from 'mongoose';

export interface DatabaseOptions extends Pick<
  ConnectOptions,
  | 'dbName'
  | 'authSource'
  | 'auth'
  | 'tls'
  | 'replicaSet'
  | 'minPoolSize'
  | 'maxPoolSize'
  | 'maxIdleTimeMS'
  | 'waitQueueTimeoutMS'
  | 'serverSelectionTimeoutMS'
  | 'connectTimeoutMS'
  | 'socketTimeoutMS'
  | 'heartbeatFrequencyMS'
  | 'autoIndex'
  | 'autoCreate'
  | 'bufferCommands'
> {
  /** Defaults to MONGODB_URI, read when the provider initializes. */
  uri?: string;
  connectionName?: string;
  /** Total startup attempts, including the first attempt. */
  retryAttempts?: number;
  retryDelay?: number;
}

export interface DatabaseAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  connectionName?: string;
  inject?: any[];
  useFactory: (
    ...args: any[]
  ) =>
    | Omit<DatabaseOptions, 'connectionName'>
    | Promise<Omit<DatabaseOptions, 'connectionName'>>;
}

export function validateConnectionName(name?: string): void {
  if (
    name !== undefined &&
    (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || name === 'DatabaseConnection')
  ) {
    throw new Error('Invalid database connectionName');
  }
}

export function resolveDatabaseOptions(
  options: DatabaseOptions,
  env: NodeJS.ProcessEnv = process.env,
): MongooseModuleOptions {
  const uri = options.uri ?? env.MONGODB_URI?.trim();
  validateConnectionName(options.connectionName);
  if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\/\S+$/.test(uri)) {
    throw new Error(
      'Database uri (MONGODB_URI) must use mongodb or mongodb+srv',
    );
  }
  try {
    // Parse without connecting, before createConnection can throw outside our safe promise boundary.
    new mongo.MongoClient(uri);
  } catch {
    throw new Error('Invalid database uri');
  }
  const resolved = {
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
    socketTimeoutMS: 3000,
    minPoolSize: 0,
    maxPoolSize: 10,
    autoIndex: false,
    retryAttempts: 3,
    retryDelay: 1000,
    ...options,
    uri,
  };
  for (const key of [
    'serverSelectionTimeoutMS',
    'connectTimeoutMS',
    'socketTimeoutMS',
    'maxPoolSize',
    'retryAttempts',
    'heartbeatFrequencyMS',
  ] as const) {
    const value = resolved[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`Invalid database ${key}`);
    }
  }
  for (const key of [
    'minPoolSize',
    'retryDelay',
    'maxIdleTimeMS',
    'waitQueueTimeoutMS',
  ] as const) {
    const value = resolved[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Invalid database ${key}`);
    }
  }
  if (resolved.minPoolSize > resolved.maxPoolSize) {
    throw new Error('Database minPoolSize must not exceed maxPoolSize');
  }
  for (const key of [
    'autoIndex',
    'autoCreate',
    'bufferCommands',
    'tls',
  ] as const) {
    if (resolved[key] !== undefined && typeof resolved[key] !== 'boolean') {
      throw new Error(`Invalid database ${key}`);
    }
  }
  return resolved;
}
