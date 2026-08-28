import { spawn } from 'bun'

async function runServerCheck(label: string, script: string, port: number, path: string, expect: string) {
  const proc = spawn(['bun', 'run', script], { stdout: 'pipe', stderr: 'pipe' })
  await new Promise((r) => setTimeout(r, 600))

  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  const body = await res.text()

  proc.kill()
  await proc.exited

  if (res.status !== 200 || !body.includes(expect)) {
    throw new Error(`${label} FAILED: status=${res.status} body=${JSON.stringify(body)}`)
  }
  console.log(`[PASS] ${label}: status=${res.status} body=${JSON.stringify(body)}`)
}

async function runScriptCheck(label: string, script: string) {
  const proc = spawn(['bun', 'run', script], { stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await proc.exited
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  console.log(`--- ${label} output ---`)
  console.log(out)
  if (exitCode !== 0) {
    console.log(`--- ${label} stderr (non-zero exit, may be an expected failure path) ---`)
    console.log(err)
  }
  return { exitCode, out, err }
}

async function main() {
  console.log('== 1. bun --version ==')
  console.log(Bun.version)

  console.log('\n== 2. Elysia hello server (curl + kill) ==')
  await runServerCheck('elysia-hello', 'spike/server-hello.ts', 7997, '/', 'hello from elysia spike')

  console.log('\n== 3a. node-pty under Bun (expected to fail, see docs/decisions/runtime-spike.md) ==')
  const ptyResult = await runScriptCheck('node-pty', 'spike/check-node-pty.ts')
  console.log(ptyResult.exitCode === 0 ? '[UNEXPECTED PASS] node-pty' : '[EXPECTED FAIL] node-pty — see decision doc for exact error')

  console.log('\n== 3b. bun-pty fallback ==')
  const bunPtyResult = await runScriptCheck('bun-pty', 'spike/check-bun-pty.ts')
  if (bunPtyResult.exitCode !== 0) throw new Error('bun-pty check FAILED — chosen pty path is broken')
  console.log('[PASS] bun-pty')

  console.log('\n== 4. Bun.build in-memory transpile ==')
  const buildResult = await runScriptCheck('bun-build', 'spike/check-bun-build.ts')
  if (buildResult.exitCode !== 0) throw new Error('Bun.build check FAILED')
  console.log('[PASS] bun-build')

  console.log('\n== 5. @elysiajs/html JSX view (curl + kill) ==')
  await runServerCheck('elysia-jsx', 'spike/server-jsx.tsx', 7998, '/view', 'hello mission control')

  console.log('\nALL SPIKE CHECKS COMPLETE')
}

await main()
