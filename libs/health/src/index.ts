export { HealthModule } from './lib/health.module';
export { HealthService } from './lib/health.service';
export {
  HealthConfigError,
  type HealthModuleAsyncOptions,
  type HealthModuleOptions,
} from './lib/options';
export type {
  HealthIndicator,
  HealthReport,
  IndicatorCheck,
  IndicatorReport,
  Probe,
  ProbeStatus,
} from './lib/types';
export { EventLoopIndicator } from './lib/indicators/event-loop.indicator';
export { MemoryIndicator } from './lib/indicators/memory.indicator';
export { TcpIndicator } from './lib/indicators/tcp.indicator';
