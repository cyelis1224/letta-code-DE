import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translatePasteForImages } from "../../cli/helpers/clipboard";
import {
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
} from "../../cli/helpers/pasteRegistry";

const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=";
const ALLOWED_ANTHROPIC_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

let capturedRequestBody: Record<string, unknown> | null = null;

const createMessage = mock(async (_conversationId: string, body: unknown) => {
  capturedRequestBody = body as Record<string, unknown>;
  return {
    [Symbol.asyncIterator]: async function* () {
      // No-op stream for request-boundary assertions.
    },
  } as AsyncIterable<unknown>;
});

mock.module("../../agent/client", () => ({
  getClient: async () => ({
    conversations: {
      messages: {
        create: createMessage,
      },
    },
  }),
  getServerUrl: () => "http://localhost:8283",
  consumeLastSDKDiagnostic: () => null,
  clearLastSDKDiagnostic: () => {},
}));

mock.module("../../agent/clientSkills", () => ({
  buildClientSkillsPayload: async () => ({
    clientSkills: [],
    errors: [],
  }),
}));

mock.module("../../tools/manager", () => ({
  waitForToolsetReady: async () => {},
  prepareCurrentToolExecutionContext: async () => {
    throw new Error(
      "prepareCurrentToolExecutionContext should not run in this test",
    );
  },
}));

mock.module("../../agent/context", () => ({
  getSkillSources: () => [],
}));

const { sendMessageStream } = await import("../../agent/message");

describe("sendMessageStream image normalization", () => {
  let tempRoot = "";
  let displayText = "";

  beforeEach(() => {
    capturedRequestBody = null;
    createMessage.mockClear();
    tempRoot = mkdtempSync(join(tmpdir(), "letta-image-send-"));
    displayText = "";
  });

  afterEach(() => {
    if (displayText) {
      clearPlaceholdersInText(displayText);
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    mock.restore();
  });

  test("normalizes TUI file-path pasted images to Anthropic-supported media types before sending", async () => {
    const imagePath = join(tempRoot, "clipboard-screenshot.tiff");
    writeFileSync(imagePath, Buffer.from(TEST_PNG_BASE64, "base64"));

    displayText = translatePasteForImages(imagePath);
    expect(displayText).toMatch(/^\[Image #\d+\]$/);

    const content = buildMessageContentFromDisplay(displayText);

    await sendMessageStream("conv-test", [{ role: "user", content }], {
      preparedToolContext: {
        contextId: "ctx-test",
        clientTools: [],
        loadedToolNames: [],
      },
    });

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(capturedRequestBody).not.toBeNull();

    const requestMessages = (capturedRequestBody as { messages?: unknown[] })
      .messages;
    expect(Array.isArray(requestMessages)).toBe(true);
    const firstMessage = requestMessages?.[0] as {
      content?: Array<{
        type: string;
        source?: { type: string; media_type: string; data: string };
      }>;
    };
    const imagePart = firstMessage.content?.find(
      (part) => part.type === "image",
    );

    expect(imagePart?.source?.type).toBe("base64");
    expect(
      ALLOWED_ANTHROPIC_MEDIA_TYPES.has(imagePart?.source?.media_type ?? ""),
    ).toBe(true);
  });

  test("normalizes direct shared-send image payloads before the API request", async () => {
    await sendMessageStream(
      "conv-test",
      [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/heic",
                data: TEST_PNG_BASE64,
              },
            },
          ],
        },
      ],
      {
        preparedToolContext: {
          contextId: "ctx-test-direct",
          clientTools: [],
          loadedToolNames: [],
        },
      },
    );

    expect(createMessage).toHaveBeenCalledTimes(1);
    const requestMessages = (capturedRequestBody as { messages?: unknown[] })
      .messages;
    const firstMessage = requestMessages?.[0] as {
      content?: Array<{
        type: string;
        source?: { type: string; media_type: string; data: string };
      }>;
    };
    const imagePart = firstMessage.content?.find(
      (part) => part.type === "image",
    );

    expect(imagePart?.source?.media_type).toBe("image/png");
  });

  test("fails closed before the API request when base64 image bytes are invalid", async () => {
    await expect(
      sendMessageStream(
        "conv-test",
        [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/tiff",
                  data: Buffer.from("not-an-image", "utf8").toString("base64"),
                },
              },
            ],
          },
        ],
        {
          preparedToolContext: {
            contextId: "ctx-test-invalid",
            clientTools: [],
            loadedToolNames: [],
          },
        },
      ),
    ).rejects.toThrow();

    expect(createMessage).not.toHaveBeenCalled();
  });
});
