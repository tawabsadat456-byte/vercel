import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Schema from '@effect/schema/Schema';
import { describe, expect, it } from 'vitest';
import type { AuthConfig, GlobalConfig } from '@vercel-internals/types';
import {
  parseAuthConfig,
  parseGlobalConfig,
  readConfigFile,
  writeConfigFile,
} from '../src';

const genericConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  name: Schema.optional(Schema.String),
});

describe('cli-config schema', () => {
  it('parses global config and preserves unknown properties', () => {
    const config = parseGlobalConfig({
      currentTeam: 'team_123',
      telemetry: {
        enabled: true,
        sampleRate: 1,
      },
      customSetting: 'kept',
    }) as GlobalConfig & Record<string, unknown>;

    expect(config).toEqual({
      currentTeam: 'team_123',
      telemetry: {
        enabled: true,
        sampleRate: 1,
      },
      customSetting: 'kept',
    });
  });

  it('rejects invalid global config shapes', () => {
    expect(() =>
      parseGlobalConfig({
        telemetry: {
          enabled: 'true',
        },
      })
    ).toThrow();
  });

  it('parses auth config and preserves unknown properties', () => {
    const config = parseAuthConfig({
      token: 'token_123',
      expiresAt: 123,
      metadata: {
        source: 'fixture',
      },
    }) as AuthConfig & Record<string, unknown>;

    expect(config).toEqual({
      token: 'token_123',
      expiresAt: 123,
      metadata: {
        source: 'fixture',
      },
    });
  });

  it('rejects invalid auth config shapes', () => {
    expect(() =>
      parseAuthConfig({
        tokenSource: 'config-file',
      })
    ).toThrow();
  });

  it('reads generic schema-backed config files', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'vercel-cli-config-'));

    try {
      const configPath = join(configDir, 'generic.json');
      await writeFile(
        configPath,
        JSON.stringify({ enabled: true, name: 'demo' }),
        'utf8'
      );

      expect(readConfigFile(configPath, genericConfigSchema)).toEqual({
        enabled: true,
        name: 'demo',
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('writes generic schema-backed config files', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'vercel-cli-config-'));

    try {
      const configPath = join(configDir, 'generic.json');
      writeConfigFile(configPath, genericConfigSchema, {
        enabled: true,
        name: 'demo',
      });

      const content = await readFile(configPath, 'utf8');
      expect(JSON.parse(content)).toEqual({ enabled: true, name: 'demo' });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
