import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { resizeImageIfNeeded } from "../cli/helpers/imageResize";

export const SUPPORTED_BASE64_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type Base64ImageContentPart = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

export function isBase64ImageContentPart(
  part: unknown,
): part is Base64ImageContentPart {
  if (!part || typeof part !== "object") {
    return false;
  }

  const candidate = part as {
    type?: unknown;
    source?: {
      type?: unknown;
      media_type?: unknown;
      data?: unknown;
    };
  };

  return (
    candidate.type === "image" &&
    !!candidate.source &&
    candidate.source.type === "base64" &&
    typeof candidate.source.media_type === "string" &&
    candidate.source.media_type.length > 0 &&
    typeof candidate.source.data === "string" &&
    candidate.source.data.length > 0
  );
}

export async function normalizeMessageContentImages(
  content: MessageCreate["content"],
  resize: typeof resizeImageIfNeeded = resizeImageIfNeeded,
): Promise<MessageCreate["content"]> {
  if (typeof content === "string") {
    return content;
  }

  let didChange = false;
  const normalizedParts = await Promise.all(
    content.map(async (part) => {
      if (!isBase64ImageContentPart(part)) {
        return part;
      }

      const resized = await resize(
        Buffer.from(part.source.data, "base64"),
        part.source.media_type,
      );

      if (
        resized.data !== part.source.data ||
        resized.mediaType !== part.source.media_type
      ) {
        didChange = true;
      }

      return {
        ...part,
        source: {
          ...part.source,
          type: "base64" as const,
          data: resized.data,
          media_type: resized.mediaType,
        },
      };
    }),
  );

  return didChange ? normalizedParts : content;
}

export async function normalizeMessageImageParts<
  T extends ApprovalCreate | MessageCreate,
>(
  messages: T[],
  resize: typeof resizeImageIfNeeded = resizeImageIfNeeded,
): Promise<T[]> {
  let didChange = false;

  const normalizedMessages = await Promise.all(
    messages.map(async (message) => {
      if (!("content" in message)) {
        return message;
      }

      const normalizedContent = await normalizeMessageContentImages(
        message.content,
        resize,
      );
      if (normalizedContent !== message.content) {
        didChange = true;
        return {
          ...message,
          content: normalizedContent,
        };
      }
      return message;
    }),
  );

  return didChange ? normalizedMessages : messages;
}

export function assertSupportedBase64ImageMediaTypes(
  messages: Array<ApprovalCreate | MessageCreate>,
): void {
  for (const message of messages) {
    if (!("content" in message) || typeof message.content === "string") {
      continue;
    }

    for (const part of message.content) {
      if (!isBase64ImageContentPart(part)) {
        continue;
      }

      if (!SUPPORTED_BASE64_IMAGE_MEDIA_TYPES.has(part.source.media_type)) {
        throw new Error(
          `Unsupported base64 image media type after normalization: ${part.source.media_type}`,
        );
      }
    }
  }
}
