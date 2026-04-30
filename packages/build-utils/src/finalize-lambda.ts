import type { Lambda } from './lambda';
import type { NodejsLambda } from './nodejs-lambda';
import type { BytecodeCachingOptions } from './process-serverless/get-lambda-preload-scripts';
import type { SupportsStreamingResult } from './process-serverless/get-lambda-supports-streaming';
import { getEncryptedEnv } from './process-serverless/get-encrypted-env-file';
import { getLambdaEnvironment } from './process-serverless/get-lambda-environment';
import { getLambdaSupportsStreaming } from './process-serverless/get-lambda-supports-streaming';
import { sha256 } from './fs/stream-to-digest-async';
import { collectUncompressedSize } from './collect-uncompressed-size';
import { createHash } from 'node:crypto';

/**
 * Optional wrapper around async work, allowing callers to inject tracing
 * (e.g. dd-trace spans) without coupling the shared code to a tracer.
 */
export type TraceFn = <T>(
  name: string,
  fn: () => Promise<T>,
  tags?: Record<string, string>
) => Promise<T>;

const defaultTrace: TraceFn = (_name, fn) => fn();

/**
 * Result of a custom ZIP creation strategy.
 */
export interface CreateZipResult {
  /** SHA-256 hex digest of the zip contents. */
  digest: string;
  getZipData: () => Promise<{
    /** Compressed size in bytes */
    size: number;
    /** The zip as a Buffer (in-memory), or null for disk-based paths. */
    buffer: Buffer | null;
    /** Path to the zip file on disk, or undefined for in-memory. */
    zipPath?: string;
  }>;
}

/**
 * Custom ZIP creation strategy. When provided, replaces the default
 * in-memory `lambda.createZip()` + `sha256()` path. This allows callers
 * to stream large zips to disk instead.
 */
export type CreateZipFn = (
  lambda: Lambda | NodejsLambda
) => Promise<CreateZipResult>;

export interface FinalizeLambdaParams {
  lambda: Lambda | NodejsLambda;
  encryptedEnvFilename?: string;
  encryptedEnvContent?: string;
  bytecodeCachingOptions: BytecodeCachingOptions;
  forceStreamingRuntime: boolean;
  /** When true, collect the uncompressed size of lambda files before zipping. */
  enableUncompressedLambdaSizeCheck?: boolean;
  /** Optional tracing wrapper for `collectUncompressedSize` and `createZip`. */
  trace?: TraceFn;
  /** Custom ZIP creation strategy. Defaults to in-memory lambda.createZip(). */
  createZip?: CreateZipFn;
}

export interface FinalizeLambdaResult {
  /** SHA-256 hex digest. */
  digest: string;
  getZipData: () => Promise<{
    /** Compressed size in bytes */
    size: number;
    /** The zip as a Buffer (in-memory), or null for disk-based paths. */
    buffer: Buffer | null;
    /** Path to the zip file on disk, or undefined for in-memory. */
    zipPath?: string;
  }>;
  uncompressedBytes: number;
  /** Non-fatal streaming detection error, if any. Caller decides how to log. */
  streamingError?: SupportsStreamingResult['error'];
}

/**
 * Core Lambda finalization logic shared between BYOF and build-container.
 *
 * This function:
 * 1. Injects encrypted env file into lambda.files when provided
 * 2. Collects uncompressed size when enabled
 * 3. Creates the ZIP (in-memory or via custom strategy)
 * 5. Computes SHA-256 digest (default path only; custom path provides its own)
 * 6. Merges environment variables (bytecode caching, helpers, etc.)
 * 7. Detects streaming support
 *
 * Note: This function mutates the `lambda` (files, environment,
 * supportsResponseStreaming).
 */
export async function finalizeLambda(
  params: FinalizeLambdaParams
): Promise<FinalizeLambdaResult> {
  const {
    lambda,
    encryptedEnvFilename,
    encryptedEnvContent,
    bytecodeCachingOptions,
    forceStreamingRuntime,
    enableUncompressedLambdaSizeCheck,
    trace = defaultTrace,
    createZip: createZipOverride,
  } = params;

  // 1. Encrypted env injection
  const encryptedEnv = getEncryptedEnv(
    encryptedEnvFilename,
    encryptedEnvContent
  );
  if (encryptedEnv) {
    const [envFilename, envFile] = encryptedEnv;
    lambda.zipBuffer = undefined;
    lambda.files = {
      ...lambda.files,
      [envFilename]: envFile,
    };
  }

  // 2. Uncompressed size collection
  let uncompressedBytes = 0;
  if (enableUncompressedLambdaSizeCheck) {
    if (lambda.files) {
      uncompressedBytes = await trace('collectUncompressedSize', () =>
        collectUncompressedSize(lambda.files ?? {})
      );
    }
  }

  // 3. ZIP creation (pluggable strategy)
  const zipTags: Record<string, string> = {
    fileCount: String(Object.keys(lambda.files ?? {}).length),
    uncompressedBytes: String(uncompressedBytes),
  };

  let zipResult: CreateZipResult;
  if (createZipOverride) {
    // Custom path (e.g. file-based): digest already computed by callback
    zipResult = await trace(
      'createZip',
      () => createZipOverride(lambda),
      zipTags
    );
  } else if (
    lambda.files &&
    Object.values(lambda.files).every(file => file.contentHash != null)
  ) {
    let digest = createHash('sha256');

    for (const file of Object.values(lambda.files)) {
      digest.update(file.contentHash!);
    }

    let buffer: Buffer | undefined = undefined;
    zipResult = {
      digest: digest.digest('hex'),
      async getZipData() {
        if (!buffer) {
          buffer = await trace('createZip', () => lambda.createZip(), zipTags);
        }
        return { buffer, size: buffer.byteLength };
      },
    };
  } else {
    // Default in-memory path: create buffer first, digest deferred to step 5
    const buffer =
      lambda.zipBuffer ||
      (await trace('createZip', () => lambda.createZip(), zipTags));
    zipResult = {
      digest: sha256(buffer),
      getZipData: async () => ({ buffer, size: buffer.byteLength }),
    };
  }

  // 6. Lambda environment
  lambda.environment = {
    ...lambda.environment,
    ...getLambdaEnvironment(
      lambda,
      { byteLength: 0 }, // <---
      bytecodeCachingOptions
    ),
  };

  // 7. Streaming detection
  const streamingResult = await getLambdaSupportsStreaming(
    lambda,
    forceStreamingRuntime
  );
  lambda.supportsResponseStreaming = streamingResult.supportsStreaming;

  return {
    digest: zipResult.digest,
    getZipData: zipResult.getZipData,
    uncompressedBytes,
    streamingError: streamingResult.error,
  };
}
