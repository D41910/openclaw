import { fetchControlUiResource } from "../../../app/browser-http.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { chatImageRenditionWidth } from "./chat-image-rendition.ts";
import {
  isManagedOutgoingMediaSource,
  loadAssistantAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import { resolveManagedImageResource, loadManagedImageBlob } from "./chat-message-image-loading.ts";
import { buildAssistantAttachmentUrl } from "./chat-message-local-media.ts";
import {
  isChatMediaResourceCurrent,
  retainManagedImageBlobUrl,
  type ImageBlock,
  type ImageRenderOptions,
} from "./chat-message-media.ts";

export function openResolvedImage(
  onOpenImage: ((item: ImageLightboxItem, requestVersion?: number) => void) | undefined,
  src: string,
  title: string,
  release?: () => void,
  requestVersion?: number,
) {
  const safeSrc = resolveSafeExternalUrl(src, window.location.href, { allowDataImage: true });
  if (!safeSrc) {
    release?.();
    return;
  }
  if (onOpenImage) {
    const item: ImageLightboxItem = { src: safeSrc, title, ...(release ? { release } : {}) };
    if (requestVersion === undefined) {
      onOpenImage(item);
    } else {
      onOpenImage(item, requestVersion);
    }
    return;
  }
  release?.();
  openExternalUrlSafe(safeSrc, { allowDataImage: true });
}

export function imageTitle(image: ImageBlock): string {
  return image.alt?.trim() || image.fileName?.trim() || t("chat.imageLightbox.untitled");
}

export async function loadGalleryImage(
  image: ImageBlock,
  opts: ImageRenderOptions | undefined,
  retryFailed: boolean,
  original = false,
): Promise<ImageLightboxItem | null> {
  let src: string | null;
  let release: (() => void) | undefined;
  if (image.url === undefined || isManagedOutgoingMediaSource(image.url)) {
    const resource = resolveManagedImageResource(
      image.url,
      opts,
      image.artifactId,
      original ? "full" : "thumbnail",
      retryFailed,
      chatImageRenditionWidth("viewer"),
    );
    src = resource.value ?? (await resource.pending) ?? null;
    if (!src || !isChatMediaResourceCurrent(resource)) {
      return null;
    }
    release = retainManagedImageBlobUrl(resource.cacheKey);
  } else {
    const availability = await loadAssistantAttachmentAvailability(image.url, opts, retryFailed);
    if (availability?.status !== "available") {
      return null;
    }
    src = buildAssistantAttachmentUrl(
      image.url,
      opts?.resourceBasePath,
      availability.mediaTicket,
      opts,
      image.fileName,
      original ? undefined : "thumbnail",
      chatImageRenditionWidth("viewer"),
    );
  }
  const safeSrc = resolveSafeExternalUrl(src, window.location.href, { allowDataImage: true });
  if (!safeSrc) {
    release?.();
    return null;
  }
  return {
    src: safeSrc,
    title: imageTitle(image),
    width: image.width,
    height: image.height,
    release,
    readOriginalBlob: () => readImageOriginalBlob(image, opts),
  };
}

export async function readImageOriginalBlob(
  image: ImageBlock,
  opts?: ImageRenderOptions,
): Promise<Blob> {
  if (image.url === undefined || isManagedOutgoingMediaSource(image.url)) {
    return await loadManagedImageBlob(image.url, opts, image.artifactId);
  }
  const original = await loadGalleryImage(image, opts, true, true);
  if (!original) {
    throw new Error("Image download is unavailable");
  }
  try {
    const response = await fetchControlUiResource(original.src, {
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      throw new Error("Image download failed");
    }
    return await response.blob();
  } finally {
    original.release?.();
  }
}
