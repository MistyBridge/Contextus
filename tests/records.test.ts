// 记录解析单测（纯函数，无外部依赖）——对应实验 §3 语义
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isQuestion,
  questions,
  ancestorPath,
  splitRounds,
  loadRecords,
  type Record,
} from "../src/records.js";

function mk(partial: Partial<Record>): Record {
  return { type: "user", uuid: "u1", ...partial };
}

test("isQuestion: 普通文本提问为 true", () => {
  assert.equal(isQuestion(mk({ message: { role: "user", content: "分析 monkiy" } })), true);
});

test("isQuestion: tool_result 消息为 false（与 tool_use 配对的消息不是提问）", () => {
  assert.equal(
    isQuestion(
      mk({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] } }),
    ),
    false,
  );
});

test("isQuestion: 本地命令伪消息（< 开头）为 false", () => {
  assert.equal(isQuestion(mk({ message: { role: "user", content: "<local-command>" } })), false);
});

test("questions: 按 promptId 去重（同一提问编辑重试记录多次）", () => {
  const recs = [
    mk({ uuid: "a", promptId: "p1", message: { role: "user", content: "问题一" } }),
    mk({ uuid: "b", promptId: "p1", message: { role: "user", content: "问题一(编辑)" } }),
    mk({ uuid: "c", promptId: "p2", message: { role: "user", content: "问题二" } }),
  ];
  const qs = questions(recs);
  assert.equal(qs.length, 2);
  assert.deepEqual(
    qs.map((q) => q.uuid),
    ["a", "c"],
  );
});

test("ancestorPath: 沿 parentUuid 回溯返回时间序链（含目标）", () => {
  const byUuid = new Map<string, Record>([
    ["r", mk({ uuid: "r" })],
    ["m", mk({ uuid: "m", parentUuid: "r" })],
    ["c", mk({ uuid: "c", parentUuid: "m" })],
  ]);
  const chain = ancestorPath(byUuid, "c");
  assert.deepEqual(
    chain.map((x) => x.uuid),
    ["r", "m", "c"],
  );
});

test("splitRounds: 按提问切分回合，提问前/无关记录被跳过", () => {
  const recs = [
    mk({ uuid: "h", type: "mode" }),
    mk({ uuid: "q1", promptId: "p1", message: { role: "user", content: "一" } }),
    mk({ uuid: "a1", type: "assistant", message: { role: "assistant", content: "答一" } }),
    mk({ uuid: "q2", promptId: "p2", message: { role: "user", content: "二" } }),
    mk({ uuid: "a2", type: "assistant", message: { role: "assistant", content: "答二" } }),
    mk({ uuid: "t", type: "system" }),
  ];
  const rounds = splitRounds(recs);
  assert.equal(rounds.length, 2);
  assert.deepEqual(
    rounds.map((r) => r.map((x) => x.uuid)),
    [
      ["q1", "a1"],
      ["q2", "a2"],
    ],
  );
});

test("loadRecords: 逐行解析并忽略空行", () => {
  const records = loadRecords('{"uuid":"a"}\n\n{"uuid":"b"}\n');
  assert.equal(records.length, 2);
  assert.equal(records[1].uuid, "b");
});
