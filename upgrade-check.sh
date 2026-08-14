#!/usr/bin/env bash
# Contextus 升级回归（实验 §9 建议落地）：Claude Code 升级后必跑
# 用法: bash upgrade-check.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/3 类型检查 =="
npx tsc --noEmit

echo "== 2/3 自动化测试（零 API + watch 真实轮次）=="
npx tsx --test tests/records.test.ts tests/m2.test.ts tests/m3.test.ts tests/scenarios.test.ts tests/replay.test.ts tests/watch.test.ts

echo "== 3/3 实验三用例（真实 API，~$0.5）=="
npx tsx tests/regression.ts

echo
echo "== 升级回归完成：全部通过 ✅ =="
