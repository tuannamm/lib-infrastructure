# Infrastructure libraries

Package dùng chung `@lib-infrastructure/core` cung cấp các module NestJS:

```ts
import { HealthModule, ServiceDiscoveryModule } from '@lib-infrastructure/core';
```

Trong bản checkout độc lập, dùng Node 24 và npm:

```sh
npm ci --legacy-peer-deps
npm exec nx run infrastructure-core:build
npm exec nx run-many -- -t test -p health service-discovery-client
npm pack --dry-run --workspace @lib-infrastructure/core
```

Để phát hành, cấu hình xác thực npm cho Nexus, cập nhật version trong `libs/core/package.json`, build rồi chạy `npm publish --workspace @lib-infrastructure/core --registry <NEXUS_NPM_URL>`. Không lưu token vào repository. Service cần cấu hình scope `@lib-infrastructure` trỏ đến Nexus và cài các peer dependencies trong package. Các thư mục `health` và `service-discovery-client` chứa mã nguồn và test; artifact `core` bao gồm cả hai module.
