import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  RABBITMQ_OPTIONS,
  resolveRabbitMQOptions,
  type RabbitMQOptions,
  type RabbitMQAsyncOptions,
} from './options';
import { RabbitMQService } from './rabbitmq.service';

@Module({})
export class RabbitMQModule {
  static forRoot(options: RabbitMQOptions = {}): DynamicModule {
    return this.build([], {
      provide: RABBITMQ_OPTIONS,
      useFactory: () => resolveRabbitMQOptions(options),
    });
  }

  static forRootAsync(options: RabbitMQAsyncOptions): DynamicModule {
    return this.build(options.imports ?? [], {
      provide: RABBITMQ_OPTIONS,
      inject: options.inject ?? [],
      useFactory: async (...args: any[]) =>
        resolveRabbitMQOptions(await options.useFactory(...args)),
    });
  }

  private static build(
    imports: NonNullable<RabbitMQAsyncOptions['imports']>,
    provider: Provider,
  ): DynamicModule {
    return {
      module: RabbitMQModule,
      imports,
      providers: [provider, RabbitMQService],
      exports: [RabbitMQService],
    };
  }
}
