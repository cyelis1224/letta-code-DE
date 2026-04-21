import { describe, expect, test } from "bun:test";
import type { ApprovalResult } from "../../agent/approval-execution";
import { buildConversationMessagesCreateRequestBody } from "../../agent/message";

describe("buildConversationMessagesCreateRequestBody client_skills", () => {
  test("includes client_skills alongside client_tools", () => {
    const body = buildConversationMessagesCreateRequestBody(
      "default",
      [{ type: "message", role: "user", content: "hello" }],
      { agentId: "agent-1", streamTokens: true, background: true },
      [
        {
          name: "ShellCommand",
          description: "Run shell command",
          parameters: { type: "object", properties: {} },
        },
      ],
      [
        {
          name: "debugging",
          description: "Debugging checklist",
          location: "/tmp/.skills/debugging/SKILL.md",
        },
      ],
    );

    expect(body.client_tools).toHaveLength(1);
    expect(body.client_skills).toEqual([
      {
        name: "debugging",
        description: "Debugging checklist",
        location: "/tmp/.skills/debugging/SKILL.md",
      },
    ]);
  });

  test("injects approval comments once when sending approval continuations", () => {
    const body = buildConversationMessagesCreateRequestBody(
      "default",
      [
        {
          type: "approval",
          approvals: [
            {
              type: "tool",
              tool_call_id: "call-1",
              tool_return: "command output",
              status: "success",
              reason: "use worktree",
            } as ApprovalResult,
          ],
        },
      ],
      { agentId: "agent-1", streamTokens: true, background: true },
      [],
      [],
    );

    const approvals =
      body.messages[0]?.type === "approval" ? body.messages[0].approvals : [];
    expect(approvals).toHaveLength(1);
    expect(approvals?.[0]).toMatchObject({
      type: "tool",
      tool_call_id: "call-1",
      status: "success",
      tool_return: [
        {
          type: "text",
          text: 'The user approved the tool execution with the following comment: "use worktree"',
        },
        {
          type: "text",
          text: "command output",
        },
      ],
    });
  });
});
