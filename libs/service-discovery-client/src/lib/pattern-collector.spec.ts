import { Controller, Module } from '@nestjs/common';
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
} from '@nestjs/core';
import { EventPattern, MessagePattern } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { collectMessagePatterns } from './pattern-collector';

// Yêu cầu Node ≥ 24.9 (NestJS 12 là ESM-only).

@Controller()
class UserController {
  @MessagePattern('user.getById')
  getById() {
    return null;
  }

  @MessagePattern(['user.list', 'user.search'])
  list() {
    return null;
  }

  @EventPattern('user.created')
  onCreated(_data: unknown) {
    return null;
  }

  @MessagePattern({ cmd: 'legacy' })
  legacy() {
    return null;
  }

  helper() {
    return null;
  }
}

@Controller()
class AuthController {
  @MessagePattern('auth.login')
  login() {
    return null;
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [UserController, AuthController],
})
class FixtureModule {}

describe('collectMessagePatterns', () => {
  it('collects string @MessagePattern from every controller, skipping events and object patterns', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FixtureModule],
    }).compile();
    const warn = vi.fn();

    const patterns = collectMessagePatterns(
      moduleRef.get(DiscoveryService),
      moduleRef.get(MetadataScanner),
      warn,
    );

    expect(patterns).toEqual([
      'auth.login',
      'user.getById',
      'user.list',
      'user.search',
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('{"cmd":"legacy"}'),
    );
  });
});
