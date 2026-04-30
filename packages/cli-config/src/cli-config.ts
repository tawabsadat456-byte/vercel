import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import * as Schema from '@effect/schema/Schema';
import XDGAppPaths from 'xdg-app-paths';
import type { AuthConfig, GlobalConfig } from '@vercel-internals/types';

const DOCS_URL =
  'https://vercel.com/docs/projects/project-configuration/global-configuration';

const passthroughProperties = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const telemetryConfigSchema = Schema.mutable(
  Schema.Struct(
    {
      enabled: Schema.optional(Schema.Boolean),
    },
    passthroughProperties
  )
);

const guidanceConfigSchema = Schema.mutable(
  Schema.Struct(
    {
      enabled: Schema.optional(Schema.Boolean),
    },
    passthroughProperties
  )
);

const authTokenStorageSchema = Schema.Literal('auto', 'file', 'keyring');

const globalConfigSchema = Schema.mutable(
  Schema.Struct(
    {
      '// Note': Schema.optional(Schema.String),
      '// Docs': Schema.optional(Schema.String),
      authTokenStorage: Schema.optional(authTokenStorageSchema),
      currentTeam: Schema.optional(Schema.String),
      api: Schema.optional(Schema.String),
      telemetry: Schema.optional(telemetryConfigSchema),
      guidance: Schema.optional(guidanceConfigSchema),
    },
    passthroughProperties
  )
);

const authConfigSchema = Schema.mutable(
  Schema.Struct(
    {
      '// Note': Schema.optional(Schema.String),
      '// Docs': Schema.optional(Schema.String),
      skipWrite: Schema.optional(Schema.Boolean),
      token: Schema.optional(Schema.String),
      userId: Schema.optional(Schema.String),
      refreshToken: Schema.optional(Schema.String),
      expiresAt: Schema.optional(Schema.Number),
      tokenSource: Schema.optional(Schema.Literal('flag', 'env')),
    },
    passthroughProperties
  )
);

const decodeGlobalConfig = Schema.decodeUnknownSync(globalConfigSchema);
const decodeAuthConfig = Schema.decodeUnknownSync(authConfigSchema);

type WriteConfigFileOptions = {
  indent?: number | string;
  mode?: number;
};

export const defaultGlobalConfig: GlobalConfig = {
  '// Note':
    'This is your Vercel config file. For more information see the global configuration documentation.',
  '// Docs': `${DOCS_URL}#config.json`,
};

export function getDefaultAuthConfig(): AuthConfig {
  return {
    '// Note': 'This is your Vercel credentials file. DO NOT SHARE!',
    '// Docs': `${DOCS_URL}#auth.json`,
  };
}

export const defaultAuthConfig: AuthConfig = getDefaultAuthConfig();

export function parseGlobalConfig(value: unknown): GlobalConfig {
  return decodeGlobalConfig(value);
}

export function parseAuthConfig(value: unknown): AuthConfig {
  return decodeAuthConfig(value);
}

function readJsonFileSync(filePath: string): unknown {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(content);
}

function writeJsonFileSync(
  filePath: string,
  value: unknown,
  options: WriteConfigFileOptions = {}
): void {
  const directory = path.dirname(filePath);
  const tempFilePath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const content = `${JSON.stringify(value, null, options.indent ?? 2)}\n`;

  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(tempFilePath, content, {
      encoding: 'utf8',
      mode: options.mode,
    });
    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempFilePath, { force: true });
    } catch {
      // Best-effort cleanup for failed atomic writes.
    }

    throw error;
  }
}

export function readConfigFile<S extends Schema.Schema.AnyNoContext>(
  configPath: string,
  schema: S
): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema)(readJsonFileSync(configPath));
}

export function writeConfigFile<S extends Schema.Schema.AnyNoContext>(
  configPath: string,
  schema: S,
  config: Schema.Schema.Type<S>,
  options?: WriteConfigFileOptions
): void {
  const normalizedConfig = Schema.encodeSync(schema)(config);
  writeJsonFileSync(configPath, normalizedConfig, {
    indent: 2,
    ...options,
  });
}

function isReadableDirectory(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isDirectory();
  } catch (_) {
    // We don't care which kind of error occured, it isn't a readable directory anyway.
    return false;
  }
}

export function getGlobalPathConfig(): string {
  const vercelDirectories = XDGAppPaths('com.vercel.cli').dataDirs();

  const possibleConfigPaths = [
    ...vercelDirectories, // latest vercel directory
    path.join(homedir(), '.now'), // legacy config in user's home directory
    ...XDGAppPaths('now').dataDirs(), // legacy XDG directory
  ];

  return (
    possibleConfigPaths.find(configPath => isReadableDirectory(configPath)) ||
    vercelDirectories[0]
  );
}

export function getConfigFilePath(configDir: string): string {
  return path.join(configDir, 'config.json');
}

export function getAuthConfigFilePath(configDir: string): string {
  return path.join(configDir, 'auth.json');
}

export function readGlobalConfigFile(configPath: string): GlobalConfig {
  return readConfigFile(configPath, globalConfigSchema);
}

export function writeGlobalConfigFile(
  configPath: string,
  config: GlobalConfig
): void {
  writeConfigFile(
    configPath,
    globalConfigSchema,
    config as Schema.Schema.Type<typeof globalConfigSchema>
  );
}

export function readAuthConfigFile(configPath: string): AuthConfig {
  return readConfigFile(configPath, authConfigSchema);
}

export function writeAuthConfigFile(
  configPath: string,
  authConfig: AuthConfig
): void {
  if (authConfig.skipWrite) {
    return;
  }

  writeConfigFile(
    configPath,
    authConfigSchema,
    authConfig as Schema.Schema.Type<typeof authConfigSchema>,
    {
      mode: 0o600,
    }
  );
}
