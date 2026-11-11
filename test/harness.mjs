// 一个够用就行的小测试运行器：没有依赖，node test/run-tests.mjs 直接跑。
// 故意不引 vitest/jest —— 这个项目要能在只有 Node 的机器上自检。

const results = [];
let current = "";

export function suite(name) {
  current = name;
}

export function test(name, fn) {
  results.push({ suite: current, name, fn });
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || "值不相等"}\n  实际: ${a}\n  期望: ${b}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}

export async function run() {
  let pass = 0;
  const failures = [];
  let lastSuite = "";

  for (const r of results) {
    if (r.suite !== lastSuite) {
      console.log(`\n  ${r.suite}`);
      lastSuite = r.suite;
    }
    try {
      await r.fn();
      console.log(`    \x1b[32m✓\x1b[0m ${r.name}`);
      pass++;
    } catch (err) {
      console.log(`    \x1b[31m✗\x1b[0m ${r.name}`);
      console.log(`      ${String(err.message).split("\n").join("\n      ")}`);
      failures.push({ ...r, err });
    }
  }

  const total = results.length;
  console.log("");
  if (failures.length) {
    console.log(`  \x1b[31m${failures.length} 个失败\x1b[0m / 共 ${total} 个`);
    process.exitCode = 1;
  } else {
    console.log(`  \x1b[32m全部通过\x1b[0m（${pass} 个）`);
  }
  return { pass, total, failures };
}

export const assert = { eq, ok };
