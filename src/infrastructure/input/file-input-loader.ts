import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseInput, type ParseInputOptions } from '../../core/input/parse-input.js';
import { ScrapeError } from '../../core/models/errors.js';
import { type InputFormat, type ParsedInput } from '../../core/models/input.js';

export interface LoadInputFileOptions extends Omit<ParseInputOptions, 'format'> {
  /** Defaults to sniffing by file extension, then by content. */
  format?: InputFormat | 'auto' | undefined;
}

/**
 * Reads a batch file from disk and runs it through the shared parser.
 *
 * Only the file access lives here — parsing, normalization and validation are
 * the pure `parseInput` used by the CLI and the web dashboard alike.
 */
export async function loadInputFile(
  filePath: string,
  options: LoadInputFileOptions,
): Promise<ParsedInput> {
  const resolved = path.resolve(filePath);

  let contents: string;
  try {
    contents = await readFile(resolved, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'file does not exist'
        : code === 'EISDIR'
          ? 'path is a directory'
          : code === 'EACCES'
            ? 'permission denied'
            : error instanceof Error
              ? error.message
              : String(error);
    throw new ScrapeError({
      code: 'config_error',
      message: `cannot read input file "${resolved}": ${reason}`,
      cause: error,
    });
  }

  const format = options.format ?? formatFromExtension(resolved);
  return parseInput(contents, { ...options, format });
}

function formatFromExtension(filePath: string): InputFormat | 'auto' {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.txt' || extension === '.csv' || extension === '.list') return 'text';
  return 'auto';
}
