/** 极简测试框架（不引依赖）：注册用例 → 顺序跑 → 汇总失败 */
export const cases: Array<[string, () => void | Promise<void>]> = [];

export function test(name: string, fn: () => void | Promise<void>) {
  cases.push([name, fn]);
}

export async function runAll(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];

  for (const [name, fn] of cases) {
    try {
      await fn();
      passed++;
    } catch (error) {
      failures.push(`${name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length) {
    console.error(`✗ ${failures.length} 个用例失败 / ${passed + failures.length}`);
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exit(1);
  }
  console.log(`✓ ${passed} 个用例通过`);
}
