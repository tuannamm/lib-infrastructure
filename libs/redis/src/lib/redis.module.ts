import { Module, type DynamicModule } from '@nestjs/common';
import {
  REDIS_OPTIONS,
  resolveRedisOptions,
  type RedisOptions,
} from './options';
import { RedisService } from './redis.service';

// Separate identity prevents explicit registrations inheriting the bare default.
@Module({})
class RegisteredRedisModule {}
function register(options: RedisOptions = {}): DynamicModule {
  return {
    module: RegisteredRedisModule,
    providers: [
      {
        provide: REDIS_OPTIONS,
        useFactory: () => resolveRedisOptions(options),
      },
      RedisService,
    ],
    exports: [RedisService],
  };
}
@Module({ imports: [register()], exports: [RegisteredRedisModule] })
export class RedisModule {
  static forRoot(options: RedisOptions = {}): DynamicModule {
    return register(options);
  }
}
