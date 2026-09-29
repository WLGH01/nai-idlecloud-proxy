"""用 Python 做变异验证，避免 PowerShell 的编码问题。"""
import subprocess, sys, io, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MUTATIONS = [
    ("破坏额度映射：训练步数字段写死为 0", "quota.js",
     "    const dailyValue = quota.dailyValueMode === 'used' ? quota.dailyUsed : quota.dailyRemaining;",
     "    const dailyValue = 0;",
     "训练步数|每日剩余|每日次数"),
    ("破坏 V5 充能：percent 写死 100", "quota.js",
     "        usage: {\n            percent: quota.v5Percent,",
     "        usage: {\n            percent: 100,",
     "V5 充能|充能"),
    ("破坏大图判定：28 步误判为大图", "quota.js",
     "export const NORMAL_STEPS_LIMIT_DEFAULT = 28;",
     "export const NORMAL_STEPS_LIMIT_DEFAULT = 23;",
     "大图"),
]

ok = True
for name, fname, old, new, pattern in MUTATIONS:
    path = os.path.join(ROOT, fname)
    orig = io.open(path, encoding="utf-8").read()
    if old not in orig:
        print(f"X 锚点未找到 [{name}]")
        ok = False
        continue
    io.open(path, "w", encoding="utf-8", newline="").write(orig.replace(old, new, 1))
    try:
        r = subprocess.run(
            [sys.executable, "--test", "--test-name-pattern", pattern,
             "test/quota.test.js", "test/server.test.js"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        caught = r.returncode != 0
        tail = " | ".join(l for l in (r.stdout or "").splitlines() if l.startswith("# pass") or l.startswith("# fail"))
        print(("OK  " if caught else "X   ") + f"变异{'被捕获' if caught else '未被捕获'} [{name}]  ->  {tail}")
        if not caught:
            ok = False
    finally:
        io.open(path, "w", encoding="utf-8", newline="").write(orig)

print("\n" + ("反向验证通过" if ok else "反向验证失败"))
sys.exit(0 if ok else 1)
