import { providerProfile } from '@open-ocr/engine/providers';
import { CliExitError } from './errors';
import type { ResolvedCliOptions } from './types';

/**
 * Keep every CLI ingress aligned with the provider profile before uploading
 * bytes. Model-dependent capabilities remain caller-selected, but known false
 * capabilities and known MIME restrictions fail locally and deterministically.
 */
export function assertProviderMediaTypeSupported(
  mimeType: string,
  options: Pick<ResolvedCliOptions, 'provider' | 'model'>,
): void {
  const profile = providerProfile(options.provider);
  const isPdf = mimeType === 'application/pdf';
  const isImage = mimeType.startsWith('image/');
  if (!isPdf && !isImage) {
    throw new CliExitError(
      `Unsupported document MIME type for ${options.provider}: ${mimeType}`,
      2,
      {
        code: 'INPUT_INVALID',
        category: 'input',
        retryable: false,
        hint: 'Use a supported image or PDF input.',
      },
    );
  }

  if (isImage && profile.inputImageMimeTypes && !profile.inputImageMimeTypes.includes(mimeType)) {
    const formats = profile.inputImageMimeTypes
      .map((supportedMimeType) => supportedMimeType.slice('image/'.length).toUpperCase())
      .join(', ');
    const heicHint = mimeType === 'image/heic' || mimeType === 'image/heif'
      ? ' Use Gemini or Kimi for native HEIC/HEIF input.'
      : '';
    throw new CliExitError(
      `${options.provider}/${options.model} accepts ${formats} image input through this CLI, not ${mimeType}`,
      2,
      {
        code: 'INPUT_INVALID',
        category: 'input',
        retryable: false,
        hint: `Convert this image to one of: ${formats}.${heicHint}`,
      },
    );
  }

  const capability = isPdf ? profile.capabilities.pdfs : profile.capabilities.images;
  if (capability !== false) return;

  const kind = isPdf ? 'PDF' : 'image';
  throw new CliExitError(
    `${options.provider}/${options.model} does not support ${kind} input in this CLI profile`,
    2,
    {
      code: 'INPUT_INVALID',
      category: 'input',
      retryable: false,
      hint: `Choose a provider/model that advertises ${kind} support, or convert the document first.`,
    },
  );
}
